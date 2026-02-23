#include "kvs.h"

#include <arpa/inet.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <memory>
#include <random>
#include <sstream>

#include <rocksdb/db.h>
#include <rocksdb/options.h>
#include <rocksdb/write_batch.h>

namespace kvs {
namespace {

long now_ms() {
  auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count();
}

uint64_t h64(const std::string& s) {
  uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return h;
}

std::string tr(std::string s) {
  while (!s.empty() && std::isspace((unsigned char)s.back())) {
    s.pop_back();
  }
  size_t i = 0;
  while (i < s.size() && std::isspace((unsigned char)s[i])) {
    i++;
  }
  return s.substr(i);
}

int hexv(char c) {
  if (c >= '0' && c <= '9') {
    return c - '0';
  }
  if (c >= 'a' && c <= 'f') {
    return 10 + c - 'a';
  }
  if (c >= 'A' && c <= 'F') {
    return 10 + c - 'A';
  }
  return -1;
}

std::string enc(const std::string& s) {
  static const char* h = "0123456789ABCDEF";
  std::string out;
  out.reserve(s.size() * 2);

  for (unsigned char c : s) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      out.push_back((char)c);
      continue;
    }
    if (c == ' ') {
      out.push_back('+');
      continue;
    }
    out.push_back('%');
    out.push_back(h[(c >> 4) & 15]);
    out.push_back(h[c & 15]);
  }
  return out;
}

std::string dec(const std::string& s) {
  std::string out;
  out.reserve(s.size());

  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '+') {
      out.push_back(' ');
      continue;
    }
    if (s[i] == '%' && i + 2 < s.size()) {
      int a = hexv(s[i + 1]);
      int b = hexv(s[i + 2]);
      if (a >= 0 && b >= 0) {
        out.push_back((char)((a << 4) | b));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

std::map<std::string, std::string> form_parse(const std::string& body) {
  std::map<std::string, std::string> out;
  size_t p = 0;

  while (p <= body.size()) {
    size_t a = body.find('&', p);
    if (a == std::string::npos) {
      a = body.size();
    }
    std::string t = body.substr(p, a - p);
    if (!t.empty()) {
      size_t e = t.find('=');
      if (e == std::string::npos) {
        out[dec(t)] = "";
      } else {
        out[dec(t.substr(0, e))] = dec(t.substr(e + 1));
      }
    }
    if (a == body.size()) {
      break;
    }
    p = a + 1;
  }
  return out;
}

std::string form_build(const std::vector<std::pair<std::string, std::string>>& kv) {
  std::ostringstream out;
  for (size_t i = 0; i < kv.size(); i++) {
    if (i > 0) {
      out << '&';
    }
    out << enc(kv[i].first) << '=' << enc(kv[i].second);
  }
  return out.str();
}

std::vector<NodeInfo> parse_nodes(const std::string& s) {
  std::vector<NodeInfo> nodes;
  size_t p = 0;

  while (p <= s.size()) {
    size_t c = s.find(',', p);
    if (c == std::string::npos) {
      c = s.size();
    }

    std::string token = tr(s.substr(p, c - p));
    if (!token.empty()) {
      size_t at = token.find('@');
      if (at != std::string::npos && at > 0) {
        std::string id = tr(token.substr(0, at));
        std::string hp = tr(token.substr(at + 1));
        if (hp.rfind("http://", 0) == 0) {
          hp = hp.substr(7);
        }

        size_t slash = hp.find('/');
        if (slash != std::string::npos) {
          hp = hp.substr(0, slash);
        }

        size_t colon = hp.rfind(':');
        if (!id.empty() && colon != std::string::npos && colon > 0) {
          NodeInfo n{id, hp.substr(0, colon), 0};
          try {
            n.port = std::stoi(hp.substr(colon + 1));
          } catch (...) {
            n.port = 0;
          }
          if (!n.host.empty() && n.port > 0) {
            nodes.push_back(n);
          }
        }
      }
    }

    if (c == s.size()) {
      break;
    }
    p = c + 1;
  }
  return nodes;
}

std::string node_key(const NodeInfo& n) {
  std::ostringstream out;
  out << n.id << '@' << n.host << ':' << n.port;
  return out.str();
}

bool read_req(int fd, Engine::Req* r) {
  std::string data;
  size_t header_end = std::string::npos;

  while (header_end == std::string::npos) {
    char buf[4096];
    ssize_t n = recv(fd, buf, sizeof(buf), 0);
    if (n <= 0) {
      return false;
    }
    data.append(buf, n);
    header_end = data.find("\r\n\r\n");
    if (data.size() > 1024 * 1024) {
      return false;
    }
  }

  std::istringstream hs(data.substr(0, header_end));
  std::string line;
  if (!std::getline(hs, line)) {
    return false;
  }
  if (!line.empty() && line.back() == '\r') {
    line.pop_back();
  }

  std::istringstream ls(line);
  ls >> r->method >> r->path;
  if (r->method.empty() || r->path.empty()) {
    return false;
  }

  size_t content_length = 0;
  while (std::getline(hs, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    size_t c = line.find(':');
    if (c == std::string::npos) {
      continue;
    }
    std::string key = line.substr(0, c);
    for (char& ch : key) {
      ch = (char)std::tolower((unsigned char)ch);
    }
    if (key == "content-length") {
      try {
        content_length = (size_t)std::stoul(tr(line.substr(c + 1)));
      } catch (...) {
        return false;
      }
    }
  }

  std::string body = data.substr(header_end + 4);
  while (body.size() < content_length) {
    char buf[4096];
    size_t want = std::min(content_length - body.size(), sizeof(buf));
    ssize_t n = recv(fd, buf, want, 0);
    if (n <= 0) {
      return false;
    }
    body.append(buf, n);
  }
  if (body.size() > content_length) {
    body.resize(content_length);
  }

  r->body = body;
  return true;
}

void send_resp(int fd, const Engine::Resp& r) {
  std::ostringstream out;
  out << "HTTP/1.1 " << r.status << " OK\r\n"
      << "Content-Type: application/x-www-form-urlencoded\r\n"
      << "Content-Length: " << r.body.size() << "\r\n"
      << "Connection: close\r\n\r\n"
      << r.body;

  std::string wire = out.str();
  size_t p = 0;
  while (p < wire.size()) {
    ssize_t n = send(fd, wire.data() + p, wire.size() - p, 0);
    if (n <= 0) {
      return;
    }
    p += (size_t)n;
  }
}

struct CRes {
  int s = 0;
  std::string b;
};

CRes post(const std::string& host, int port, const std::string& path, const std::string& body, int timeout_ms) {
  CRes r;

  addrinfo hint{};
  hint.ai_family = AF_UNSPEC;
  hint.ai_socktype = SOCK_STREAM;

  addrinfo* res = nullptr;
  if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hint, &res) != 0) {
    return r;
  }

  int fd = -1;
  for (auto* x = res; x; x = x->ai_next) {
    fd = socket(x->ai_family, x->ai_socktype, x->ai_protocol);
    if (fd < 0) {
      continue;
    }

    timeval tv{};
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(fd, x->ai_addr, x->ai_addrlen) == 0) {
      break;
    }
    close(fd);
    fd = -1;
  }

  freeaddrinfo(res);
  if (fd < 0) {
    return r;
  }

  std::ostringstream req;
  req << "POST " << path << " HTTP/1.1\r\n"
      << "Host: " << host << ':' << port << "\r\n"
      << "Content-Type: application/x-www-form-urlencoded\r\n"
      << "Content-Length: " << body.size() << "\r\n"
      << "Connection: close\r\n\r\n"
      << body;

  std::string wire = req.str();
  for (size_t off = 0; off < wire.size();) {
    ssize_t n = send(fd, wire.data() + off, wire.size() - off, 0);
    if (n <= 0) {
      close(fd);
      return r;
    }
    off += (size_t)n;
  }

  std::string data;
  char buf[4096];
  ssize_t n = 0;
  while ((n = recv(fd, buf, sizeof(buf), 0)) > 0) {
    data.append(buf, n);
  }
  close(fd);

  size_t header_end = data.find("\r\n\r\n");
  if (header_end == std::string::npos) {
    return r;
  }

  std::istringstream hs(data.substr(0, header_end));
  std::string status_line;
  if (!std::getline(hs, status_line)) {
    return r;
  }
  if (!status_line.empty() && status_line.back() == '\r') {
    status_line.pop_back();
  }

  std::istringstream ss(status_line);
  std::string http_v;
  ss >> http_v >> r.s;
  r.b = data.substr(header_end + 4);
  return r;
}

std::string pid_new() {
  static thread_local std::mt19937_64 g(std::random_device{}());
  static const char* h = "0123456789abcdef";
  std::string x;
  for (int i = 0; i < 8; i++) {
    x.push_back(h[g() & 15]);
  }
  return std::to_string(now_ms()) + "-" + x;
}

std::string title_index_key(long created_at, const std::string& id) {
  static constexpr long kMaxTs = 9999999999999L;
  long ts = created_at;
  if (ts < 0) {
    ts = 0;
  } else if (ts > kMaxTs) {
    ts = kMaxTs;
  }
  const long rev = kMaxTs - ts;
  std::ostringstream out;
  out << "t:" << std::setw(13) << std::setfill('0') << rev << ':' << id;
  return out.str();
}

}  // namespace

Engine::Engine(Config cfg)
    : cfg_(std::move(cfg)), nodes_(parse_nodes(cfg_.cluster_nodes)) {
  if (cfg_.single_node) {
    nodes_.clear();
    nodes_.push_back({cfg_.node_id, "127.0.0.1", cfg_.port});
    return;
  }
  bool self = false;
  for (const auto& n : nodes_) {
    if (n.id == cfg_.node_id) {
      self = true;
      break;
    }
  }
  if (!self) {
    nodes_.push_back({cfg_.node_id, "127.0.0.1", cfg_.port});
  }
}

Engine::~Engine() {
  Stop();
}

bool Engine::InitDb() {
  std::error_code ec;
  std::filesystem::create_directories(cfg_.db_path, ec);
  if (ec) {
    return false;
  }

  std::vector<std::string> names;
  if (std::filesystem::exists(cfg_.db_path + "/CURRENT")) {
    rocksdb::Options o;
    if (!rocksdb::DB::ListColumnFamilies(o, cfg_.db_path, &names).ok()) {
      return false;
    }
  }

  auto add = [&](const std::string& n) {
    if (std::find(names.begin(), names.end(), n) == names.end()) {
      names.push_back(n);
    }
  };
  add(rocksdb::kDefaultColumnFamilyName);
  add("account");
  add("post");

  std::vector<rocksdb::ColumnFamilyDescriptor> desc;
  for (const auto& n : names) {
    desc.emplace_back(n, rocksdb::ColumnFamilyOptions());
  }

  rocksdb::DBOptions o;
  o.create_if_missing = true;
  o.create_missing_column_families = true;

  rocksdb::DB* db = nullptr;
  std::vector<rocksdb::ColumnFamilyHandle*> handles;
  if (!rocksdb::DB::Open(o, cfg_.db_path, desc, &handles, &db).ok()) {
    return false;
  }

  db_ = db;
  for (size_t i = 0; i < names.size(); i++) {
    cfs_.push_back(handles[i]);
    if (names[i] == rocksdb::kDefaultColumnFamilyName) {
      def_cf_ = handles[i];
    } else if (names[i] == "account") {
      acc_cf_ = handles[i];
    } else if (names[i] == "post") {
      post_cf_ = handles[i];
    }
  }

  return def_cf_ && acc_cf_ && post_cf_;
}

void Engine::CloseDb() {
  for (void* h : cfs_) {
    delete static_cast<rocksdb::ColumnFamilyHandle*>(h);
  }
  cfs_.clear();
  def_cf_ = nullptr;
  acc_cf_ = nullptr;
  post_cf_ = nullptr;

  if (db_) {
    delete static_cast<rocksdb::DB*>(db_);
    db_ = nullptr;
  }
}

bool Engine::Start() {
  if (!InitDb()) {
    return false;
  }
  std::cout << "[kvs] node=" << cfg_.node_id
            << " listen=0.0.0.0:" << cfg_.port
            << " db_path=" << cfg_.db_path
            << " single_node=" << (cfg_.single_node ? "true" : "false")
            << " cluster_nodes=" << cfg_.cluster_nodes
            << std::endl;
  stop_ = false;
  th_ = std::thread(&Engine::Serve, this);
  return true;
}

void Engine::Stop() {
  if (stop_) {
    return;
  }
  stop_ = true;
  if (listen_fd_ >= 0) {
    close(listen_fd_);
    listen_fd_ = -1;
  }
  if (th_.joinable()) {
    th_.join();
  }
  CloseDb();
}

void Engine::Serve() {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    return;
  }

  int on = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)cfg_.port);
  a.sin_addr.s_addr = INADDR_ANY;

  if (bind(fd, (sockaddr*)&a, sizeof(a)) != 0 || listen(fd, 128) != 0) {
    close(fd);
    return;
  }
  listen_fd_ = fd;

  while (!stop_) {
    fd_set s;
    FD_ZERO(&s);
    FD_SET(fd, &s);
    timeval tv{};
    tv.tv_usec = 200000;

    if (select(fd + 1, &s, nullptr, nullptr, &tv) <= 0) {
      continue;
    }

    sockaddr_in ca{};
    socklen_t cl = sizeof(ca);
    int cfd = accept(fd, (sockaddr*)&ca, &cl);
    if (cfd < 0) {
      continue;
    }

    std::thread([this, cfd]() {
      Req q;
      if (read_req(cfd, &q)) {
        send_resp(cfd, Handle(q));
      }
      close(cfd);
    }).detach();
  }
}

Engine::Resp Engine::Handle(const Req& r) {
  if (r.method != "POST") {
    return {405, form_build({{"ok", "0"}, {"error", "method"}})};
  }

  if (r.path == "/account/create") return CreateAccount(r);
  if (r.path == "/account/get") return GetAccount(r);
  if (r.path == "/post/create") return CreatePost(r);
  if (r.path == "/post/get") return GetPost(r);
  if (r.path == "/post/titles") return ListTitles(r);

  if (r.path == "/internal/account/put") return PutAccountInternal(r);
  if (r.path == "/internal/account/get") return GetAccountInternal(r);
  if (r.path == "/internal/post/put") return PutPostInternal(r);
  if (r.path == "/internal/post/get") return GetPostInternal(r);
  if (r.path == "/internal/post/titles") return ListTitlesInternal(r);
  if (r.path == "/internal/ping") return Ping();

  return {404, form_build({{"ok", "0"}, {"error", "path"}})};
}

bool Engine::PutAccount(
    const std::string& id,
    const std::string& name,
    const std::string& password_hash,
    long created_at,
    bool if_absent,
    bool* created) {
  auto* db = static_cast<rocksdb::DB*>(db_);
  auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(acc_cf_);

  std::lock_guard<std::mutex> lk(mu_);
  std::string key = "a:" + id;

  if (if_absent) {
    std::string ex;
    auto st = db->Get(rocksdb::ReadOptions(), cf, key, &ex);
    if (st.ok()) {
      *created = false;
      return true;
    }
    if (!st.IsNotFound()) {
      return false;
    }
  }

  std::string value = form_build({
      {"id", id},
      {"name", name},
      {"password_hash", password_hash},
      {"created_at", std::to_string(created_at)},
  });
  if (!db->Put(rocksdb::WriteOptions(), cf, key, value).ok()) {
    return false;
  }
  *created = true;
  return true;
}

bool Engine::PutPost(const Post& p, bool if_absent, bool* created) {
  auto* db = static_cast<rocksdb::DB*>(db_);
  auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(post_cf_);

  std::lock_guard<std::mutex> lk(mu_);
  std::string key = "p:" + p.id;
  std::string old_value;
  bool had_old = false;

  if (if_absent) {
    std::string ex;
    auto st = db->Get(rocksdb::ReadOptions(), cf, key, &ex);
    if (st.ok()) {
      *created = false;
      return true;
    }
    if (!st.IsNotFound()) {
      return false;
    }
  } else {
    auto st = db->Get(rocksdb::ReadOptions(), cf, key, &old_value);
    if (st.ok()) {
      had_old = true;
    } else if (!st.IsNotFound()) {
      return false;
    }
  }

  std::string value = form_build({
      {"id", p.id},
      {"account_id", p.account_id},
      {"title", p.title},
      {"content", p.content},
      {"created_at", std::to_string(p.created_at)},
  });

  rocksdb::WriteBatch batch;
  batch.Put(cf, key, value);
  batch.Put(cf, title_index_key(p.created_at, p.id), form_build({
      {"id", p.id},
      {"account_id", p.account_id},
      {"title", p.title},
      {"created_at", std::to_string(p.created_at)},
  }));
  if (had_old) {
    auto old = form_parse(old_value);
    const std::string old_id = old["id"].empty() ? p.id : old["id"];
    long old_created_at = 0;
    try {
      old_created_at = std::stol(old["created_at"]);
    } catch (...) {
      old_created_at = 0;
    }
    if (old_id != p.id || old_created_at != p.created_at) {
      batch.Delete(cf, title_index_key(old_created_at, old_id));
    }
  }

  if (!db->Write(rocksdb::WriteOptions(), &batch).ok()) {
    return false;
  }
  *created = true;
  return true;
}

bool Engine::ReadAccount(
    const std::string& id,
    std::string* name,
    std::string* password_hash,
    long* created_at) {
  auto* db = static_cast<rocksdb::DB*>(db_);
  auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(acc_cf_);

  std::string value;
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (!db->Get(rocksdb::ReadOptions(), cf, "a:" + id, &value).ok()) {
      return false;
    }
  }

  auto f = form_parse(value);
  if (f["id"].empty()) {
    return false;
  }

  *name = f["name"];
  *password_hash = f["password_hash"];
  try {
    *created_at = std::stol(f["created_at"]);
  } catch (...) {
    *created_at = 0;
  }
  return true;
}

bool Engine::ReadPost(const std::string& id, Post* out) {
  auto* db = static_cast<rocksdb::DB*>(db_);
  auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(post_cf_);

  std::string value;
  {
    std::lock_guard<std::mutex> lk(mu_);
    if (!db->Get(rocksdb::ReadOptions(), cf, "p:" + id, &value).ok()) {
      return false;
    }
  }

  auto f = form_parse(value);
  out->id = f["id"];
  out->account_id = f["account_id"];
  out->title = f["title"];
  out->content = f["content"];
  try {
    out->created_at = std::stol(f["created_at"]);
  } catch (...) {
    out->created_at = 0;
  }
  return !out->id.empty();
}

std::vector<Engine::Post> Engine::LocalTitles(int limit) {
  std::vector<Post> indexed;
  std::vector<Post> scanned;
  auto* db = static_cast<rocksdb::DB*>(db_);
  auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(post_cf_);

  std::lock_guard<std::mutex> lk(mu_);
  std::unique_ptr<rocksdb::Iterator> it(db->NewIterator(rocksdb::ReadOptions(), cf));

  for (it->Seek("t:"); it->Valid(); it->Next()) {
    std::string key = it->key().ToString();
    if (key.rfind("t:", 0) != 0) {
      break;
    }
    auto f = form_parse(it->value().ToString());
    Post p;
    p.id = f["id"];
    p.account_id = f["account_id"];
    p.title = f["title"];
    try {
      p.created_at = std::stol(f["created_at"]);
    } catch (...) {
      p.created_at = 0;
    }
    if (!p.id.empty()) {
      indexed.push_back(p);
      if (limit > 0 && (int)indexed.size() >= limit) {
        return indexed;
      }
    }
  }

  if (!indexed.empty()) {
    return indexed;
  }

  for (it->Seek("p:"); it->Valid(); it->Next()) {
    std::string key = it->key().ToString();
    if (key.rfind("p:", 0) != 0) {
      break;
    }
    auto f = form_parse(it->value().ToString());
    Post p;
    p.id = f["id"];
    p.account_id = f["account_id"];
    p.title = f["title"];
    try {
      p.created_at = std::stol(f["created_at"]);
    } catch (...) {
      p.created_at = 0;
    }
    if (!p.id.empty()) {
      scanned.push_back(p);
    }
  }

  if (!scanned.empty()) {
    rocksdb::WriteBatch batch;
    for (const auto& p : scanned) {
      batch.Put(cf, title_index_key(p.created_at, p.id), form_build({
          {"id", p.id},
          {"account_id", p.account_id},
          {"title", p.title},
          {"created_at", std::to_string(p.created_at)},
      }));
    }
    db->Write(rocksdb::WriteOptions(), &batch);
  }

  if (limit <= 0) {
    return scanned;
  }

  if (scanned.empty()) {
    return scanned;
  }

  std::sort(scanned.begin(), scanned.end(), [](const Post& a, const Post& b) {
    if (a.created_at == b.created_at) {
      return a.id > b.id;
    }
    return a.created_at > b.created_at;
  });
  if ((int)scanned.size() > limit) {
    scanned.resize((size_t)limit);
  }
  return scanned;
}

bool Engine::LookupAliveMemo(const NodeInfo& n, bool* alive) {
  const int alive_ttl_ms = std::max(0, cfg_.alive_cache_ms);
  const int dead_ttl_ms = std::max(0, cfg_.dead_cache_ms);
  if (alive_ttl_ms <= 0 && dead_ttl_ms <= 0) {
    return false;
  }

  const auto key = node_key(n);
  const long now = now_ms();
  std::lock_guard<std::mutex> lk(alive_mu_);
  auto it = alive_memo_.find(key);
  if (it == alive_memo_.end()) {
    return false;
  }
  if (it->second.expires_at <= now) {
    alive_memo_.erase(it);
    return false;
  }
  *alive = it->second.alive;
  return true;
}

void Engine::StoreAliveMemo(const NodeInfo& n, bool alive) {
  const int ttl_ms = alive ? std::max(0, cfg_.alive_cache_ms) : std::max(0, cfg_.dead_cache_ms);
  if (ttl_ms <= 0) {
    return;
  }

  const auto key = node_key(n);
  std::lock_guard<std::mutex> lk(alive_mu_);
  alive_memo_[key] = AliveMemo{alive, now_ms() + ttl_ms};
}

bool Engine::Alive(const NodeInfo& n) {
  if (cfg_.single_node) {
    return true;
  }
  if (n.id == cfg_.node_id) {
    return true;
  }

  bool cached = false;
  if (LookupAliveMemo(n, &cached)) {
    return cached;
  }

  int status = 0;
  std::string out;
  const int ping_timeout_ms = cfg_.alive_probe_timeout_ms > 0 ? cfg_.alive_probe_timeout_ms : cfg_.rpc_timeout_ms;
  const bool ok = Call(n, "/internal/ping", "", &status, &out, ping_timeout_ms) &&
      status == 200 &&
      form_parse(out)["ok"] == "1";
  StoreAliveMemo(n, ok);
  return ok;
}

std::vector<NodeInfo> Engine::PostOwners(const std::string& id, bool alive_only) {
  if (cfg_.single_node) {
    return std::vector<NodeInfo>{{cfg_.node_id, "127.0.0.1", cfg_.port}};
  }
  std::vector<NodeInfo> nodes = nodes_;
  std::sort(nodes.begin(), nodes.end(), [&](const NodeInfo& a, const NodeInfo& b) {
    auto ha = h64(id + "|" + a.id);
    auto hb = h64(id + "|" + b.id);
    if (ha == hb) {
      return a.id < b.id;
    }
    return ha > hb;
  });

  if (!alive_only) {
    return nodes;
  }

  if (nodes.empty()) {
    return {};
  }

  std::vector<int> up(nodes.size(), 0);
  std::vector<std::thread> workers;
  workers.reserve(nodes.size());
  for (size_t i = 0; i < nodes.size(); i++) {
    workers.emplace_back([&, i]() {
      up[i] = Alive(nodes[i]) ? 1 : 0;
    });
  }
  for (auto& worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }

  std::vector<NodeInfo> alive;
  alive.reserve(nodes.size());
  for (size_t i = 0; i < nodes.size(); i++) {
    if (up[i] != 0) {
      alive.push_back(nodes[i]);
    }
  }
  return alive;
}

bool Engine::Call(
    const NodeInfo& n,
    const std::string& path,
    const std::string& body,
    int* status,
    std::string* out,
    int timeout_ms) {
  int call_timeout_ms = timeout_ms > 0 ? timeout_ms : cfg_.rpc_timeout_ms;
  if (call_timeout_ms <= 0) {
    call_timeout_ms = 450;
  }
  auto r = post(n.host, n.port, path, body, call_timeout_ms);
  *status = r.s;
  *out = r.b;
  return r.s > 0;
}

Engine::Resp Engine::CreateAccount(const Req& r) {
  auto f = form_parse(r.body);
  std::string id = f["id"];
  std::string name = f["name"];
  std::string password_hash = f["password_hash"];
  if (id.empty() || name.empty()) {
    return {400, form_build({{"ok", "0"}, {"error", "id_name"}})};
  }

  long created_at = now_ms();
  bool created = false;
  if (!PutAccount(id, name, password_hash, created_at, true, &created)) {
    return {500, form_build({{"ok", "0"}, {"error", "db"}})};
  }
  if (!created) {
    return {409, form_build({{"ok", "0"}, {"error", "exists"}})};
  }

  std::string body = form_build({
      {"id", id},
      {"name", name},
      {"password_hash", password_hash},
      {"created_at", std::to_string(created_at)},
  });

  if (!cfg_.single_node) {
    std::vector<NodeInfo> targets;
    for (const auto& n : nodes_) {
      if (n.id == cfg_.node_id) {
        continue;
      }
      targets.push_back(n);
    }
    std::atomic<bool> failed{false};
    std::vector<std::thread> workers;
    workers.reserve(targets.size());
    for (const auto& n : targets) {
      workers.emplace_back([&, n]() {
        int status = 0;
        std::string out;
        const bool ok =
            Call(n, "/internal/account/put", body, &status, &out) &&
            status == 200 &&
            form_parse(out)["ok"] == "1";
        StoreAliveMemo(n, ok);
        if (!ok) {
          failed.store(true, std::memory_order_relaxed);
        }
      });
    }
    for (auto& worker : workers) {
      if (worker.joinable()) {
        worker.join();
      }
    }
    if (failed.load(std::memory_order_relaxed)) {
      return {503, form_build({{"ok", "0"}, {"error", "replicate_account"}})};
    }
  }

  return {200, form_build({{"ok", "1"}, {"id", id}, {"name", name}})};
}

Engine::Resp Engine::GetAccount(const Req& r) {
  auto f = form_parse(r.body);
  std::string id = f["id"];
  if (id.empty()) {
    return {400, form_build({{"ok", "0"}, {"error", "id"}})};
  }

  std::string name;
  std::string password_hash;
  long created_at = 0;
  if (ReadAccount(id, &name, &password_hash, &created_at)) {
    return {200, form_build({
        {"ok", "1"},
        {"id", id},
        {"name", name},
        {"password_hash", password_hash},
        {"created_at", std::to_string(created_at)},
    })};
  }
  if (cfg_.single_node) {
    return {404, form_build({{"ok", "0"}, {"error", "not_found"}})};
  }

  const int read_timeout_ms = cfg_.read_remote_timeout_ms > 0 ? cfg_.read_remote_timeout_ms : cfg_.rpc_timeout_ms;
  std::atomic<bool> found{false};
  std::string hit;
  std::mutex hit_mu;
  std::vector<std::thread> workers;
  workers.reserve(nodes_.size());
  for (const auto& n : nodes_) {
    if (n.id == cfg_.node_id) {
      continue;
    }
    workers.emplace_back([&, n]() {
      if (found.load(std::memory_order_relaxed)) {
        return;
      }
      int status = 0;
      std::string out;
      const bool ok =
          Call(n, "/internal/account/get", form_build({{"id", id}}), &status, &out, read_timeout_ms) &&
          status == 200 &&
          form_parse(out)["ok"] == "1";
      StoreAliveMemo(n, ok);
      if (!ok) {
        return;
      }
      bool expected = false;
      if (found.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        std::lock_guard<std::mutex> lk(hit_mu);
        hit = std::move(out);
      }
    });
  }
  for (auto& worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }
  if (found.load(std::memory_order_relaxed)) {
    return {200, hit};
  }

  return {404, form_build({{"ok", "0"}, {"error", "not_found"}})};
}

Engine::Resp Engine::CreatePost(const Req& r) {
  auto f = form_parse(r.body);
  Post p{f["id"], f["account_id"], f["title"], f["content"], now_ms()};
  if (p.id.empty()) {
    p.id = pid_new();
  }

  if (p.account_id.empty() || p.title.empty() || p.content.empty()) {
    return {400, form_build({{"ok", "0"}, {"error", "fields"}})};
  }

  {
    auto* db = static_cast<rocksdb::DB*>(db_);
    auto* cf = static_cast<rocksdb::ColumnFamilyHandle*>(acc_cf_);
    std::string account;
    std::lock_guard<std::mutex> lk(mu_);
    if (!db->Get(rocksdb::ReadOptions(), cf, "a:" + p.account_id, &account).ok()) {
      return {404, form_build({{"ok", "0"}, {"error", "account"}})};
    }
  }

  std::vector<NodeInfo> owners;
  if (cfg_.single_node) {
    owners.push_back({cfg_.node_id, "127.0.0.1", cfg_.port});
  } else {
    auto cand = PostOwners(p.id, true);
    for (const auto& n : cand) {
      owners.push_back(n);
      if (owners.size() == 2) {
        break;
      }
    }
    if (owners.size() < 2) {
      return {503, form_build({{"ok", "0"}, {"error", "alive_lt_2"}})};
    }
  }

  std::string body = form_build({
      {"id", p.id},
      {"account_id", p.account_id},
      {"title", p.title},
      {"content", p.content},
      {"created_at", std::to_string(p.created_at)},
      {"if_absent", "1"},
  });

  std::vector<int> replicated(owners.size(), 0);
  std::vector<std::thread> workers;
  workers.reserve(owners.size());
  for (size_t i = 0; i < owners.size(); i++) {
    workers.emplace_back([&, i]() {
      const auto& n = owners[i];
      bool ok = false;
      if (n.id == cfg_.node_id) {
        bool created = false;
        ok = PutPost(p, true, &created) && created;
      } else {
        int status = 0;
        std::string out;
        ok = Call(n, "/internal/post/put", body, &status, &out) &&
            status == 200 &&
            form_parse(out)["ok"] == "1";
        StoreAliveMemo(n, ok);
      }
      replicated[i] = ok ? 1 : 0;
    });
  }
  for (auto& worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }
  for (int ok : replicated) {
    if (ok == 0) {
      return {503, form_build({{"ok", "0"}, {"error", "replicate_post"}})};
    }
  }

  return {200, form_build({
      {"ok", "1"},
      {"id", p.id},
      {"account_id", p.account_id},
      {"title", p.title},
      {"content", p.content},
      {"created_at", std::to_string(p.created_at)},
  })};
}

Engine::Resp Engine::GetPost(const Req& r) {
  auto f = form_parse(r.body);
  std::string id = f["id"];
  if (id.empty()) {
    return {400, form_build({{"ok", "0"}, {"error", "id"}})};
  }

  Post p;
  if (ReadPost(id, &p)) {
    return {200, form_build({
        {"ok", "1"},
        {"id", p.id},
        {"account_id", p.account_id},
        {"title", p.title},
        {"content", p.content},
        {"created_at", std::to_string(p.created_at)},
    })};
  }
  if (cfg_.single_node) {
    return {404, form_build({{"ok", "0"}, {"error", "not_found"}})};
  }

  const int read_timeout_ms = cfg_.read_remote_timeout_ms > 0 ? cfg_.read_remote_timeout_ms : cfg_.rpc_timeout_ms;
  const auto owners = PostOwners(id, false);
  std::atomic<bool> found{false};
  std::string hit;
  std::mutex hit_mu;
  std::vector<std::thread> workers;
  workers.reserve(owners.size());
  for (const auto& n : owners) {
    if (n.id == cfg_.node_id) {
      continue;
    }
    workers.emplace_back([&, n]() {
      if (found.load(std::memory_order_relaxed)) {
        return;
      }
      int status = 0;
      std::string out;
      const bool ok =
          Call(n, "/internal/post/get", form_build({{"id", id}}), &status, &out, read_timeout_ms) &&
          status == 200 &&
          form_parse(out)["ok"] == "1";
      StoreAliveMemo(n, ok);
      if (!ok) {
        return;
      }
      bool expected = false;
      if (found.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        std::lock_guard<std::mutex> lk(hit_mu);
        hit = std::move(out);
      }
    });
  }
  for (auto& worker : workers) {
    if (worker.joinable()) {
      worker.join();
    }
  }
  if (found.load(std::memory_order_relaxed)) {
    return {200, hit};
  }

  return {404, form_build({{"ok", "0"}, {"error", "not_found"}})};
}

Engine::Resp Engine::ListTitles(const Req& r) {
  int lim = 100;
  auto in = form_parse(r.body);
  try {
    lim = std::max(1, std::stoi(in["limit"]));
  } catch (...) {
  }

  std::map<std::string, Post> merged;
  const int local_limit = lim;
  for (const auto& p : LocalTitles(local_limit)) {
    merged[p.id] = p;
  }

  if (!cfg_.single_node && cfg_.list_titles_remote_enabled) {
    const int per_peer_limit = std::max(1, std::min(lim, cfg_.list_titles_remote_per_peer_limit));
    const int remote_timeout_ms = cfg_.list_titles_remote_timeout_ms > 0 ? cfg_.list_titles_remote_timeout_ms : cfg_.rpc_timeout_ms;
    const int remote_budget_ms = std::max(0, cfg_.list_titles_remote_budget_ms);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(remote_budget_ms);

    std::mutex merge_mu;
    std::vector<std::thread> workers;
    workers.reserve(nodes_.size());

    for (const auto& n : nodes_) {
      if (n.id == cfg_.node_id) {
        continue;
      }
      workers.emplace_back([&, n]() {
        if (remote_budget_ms > 0 && std::chrono::steady_clock::now() >= deadline) {
          return;
        }

        int status = 0;
        std::string out;
        const bool ok =
            Call(
                n,
                "/internal/post/titles",
                form_build({{"limit", std::to_string(per_peer_limit)}}),
                &status,
                &out,
                remote_timeout_ms) &&
            status == 200;
        StoreAliveMemo(n, ok);
        if (!ok) {
          return;
        }

        if (remote_budget_ms > 0 && std::chrono::steady_clock::now() >= deadline) {
          return;
        }

        auto f = form_parse(out);
        if (f["ok"] != "1") {
          return;
        }

        int c = 0;
        try {
          c = std::stoi(f["count"]);
        } catch (...) {
          c = 0;
        }

        std::lock_guard<std::mutex> lk(merge_mu);
        for (int i = 0; i < c; i++) {
          std::string k = std::to_string(i);
          std::string id = f["id" + k];
          if (id.empty()) {
            continue;
          }

          Post p;
          p.id = id;
          p.account_id = f["account_id" + k];
          p.title = f["title" + k];
          try {
            p.created_at = std::stol(f["created_at" + k]);
          } catch (...) {
            p.created_at = 0;
          }

          auto it = merged.find(id);
          if (it == merged.end() || p.created_at > it->second.created_at) {
            merged[id] = p;
          }
        }
      });
    }

    for (auto& worker : workers) {
      if (worker.joinable()) {
        worker.join();
      }
    }
  }

  std::vector<Post> items;
  for (const auto& it : merged) {
    items.push_back(it.second);
  }

  std::sort(items.begin(), items.end(), [](const Post& a, const Post& b) {
    if (a.created_at == b.created_at) {
      return a.id > b.id;
    }
    return a.created_at > b.created_at;
  });

  if ((int)items.size() > lim) {
    items.resize((size_t)lim);
  }

  std::vector<std::pair<std::string, std::string>> out{{"ok", "1"}, {"count", std::to_string(items.size())}};
  for (size_t i = 0; i < items.size(); i++) {
    std::string k = std::to_string(i);
    out.push_back({"id" + k, items[i].id});
    out.push_back({"account_id" + k, items[i].account_id});
    out.push_back({"title" + k, items[i].title});
    out.push_back({"created_at" + k, std::to_string(items[i].created_at)});
  }

  return {200, form_build(out)};
}

Engine::Resp Engine::PutAccountInternal(const Req& r) {
  auto f = form_parse(r.body);
  long created_at = now_ms();
  try {
    created_at = std::stol(f["created_at"]);
  } catch (...) {
  }

  bool created = false;
  if (!PutAccount(f["id"], f["name"], f["password_hash"], created_at, false, &created)) {
    return {500, form_build({{"ok", "0"}})};
  }
  return {200, form_build({{"ok", "1"}})};
}

Engine::Resp Engine::GetAccountInternal(const Req& r) {
  auto f = form_parse(r.body);
  std::string id = f["id"];
  if (id.empty()) {
    return {400, form_build({{"ok", "0"}, {"error", "id"}})};
  }

  std::string name;
  std::string password_hash;
  long created_at = 0;
  if (!ReadAccount(id, &name, &password_hash, &created_at)) {
    return {404, form_build({{"ok", "0"}, {"error", "not_found"}})};
  }

  return {200, form_build({
      {"ok", "1"},
      {"id", id},
      {"name", name},
      {"password_hash", password_hash},
      {"created_at", std::to_string(created_at)},
  })};
}

Engine::Resp Engine::PutPostInternal(const Req& r) {
  auto f = form_parse(r.body);
  Post p{f["id"], f["account_id"], f["title"], f["content"], 0};
  try {
    p.created_at = std::stol(f["created_at"]);
  } catch (...) {
    p.created_at = now_ms();
  }

  bool created = false;
  bool if_absent = (f["if_absent"] == "1");
  if (!PutPost(p, if_absent, &created)) {
    return {500, form_build({{"ok", "0"}})};
  }
  if (if_absent && !created) {
    return {409, form_build({{"ok", "0"}, {"error", "exists"}})};
  }
  return {200, form_build({{"ok", "1"}})};
}

Engine::Resp Engine::GetPostInternal(const Req& r) {
  auto f = form_parse(r.body);
  Post p;
  if (!ReadPost(f["id"], &p)) {
    return {404, form_build({{"ok", "0"}})};
  }
  return {200, form_build({
      {"ok", "1"},
      {"id", p.id},
      {"account_id", p.account_id},
      {"title", p.title},
      {"content", p.content},
      {"created_at", std::to_string(p.created_at)},
  })};
}

Engine::Resp Engine::ListTitlesInternal(const Req& r) {
  int lim = 100;
  auto in = form_parse(r.body);
  try {
    lim = std::max(1, std::stoi(in["limit"]));
  } catch (...) {
  }

  auto items = LocalTitles(lim);
  std::vector<std::pair<std::string, std::string>> out{{"ok", "1"}, {"count", std::to_string(items.size())}};
  for (size_t i = 0; i < items.size(); i++) {
    std::string k = std::to_string(i);
    out.push_back({"id" + k, items[i].id});
    out.push_back({"account_id" + k, items[i].account_id});
    out.push_back({"title" + k, items[i].title});
    out.push_back({"created_at" + k, std::to_string(items[i].created_at)});
  }
  return {200, form_build(out)};
}

Engine::Resp Engine::Ping() {
  return {200, form_build({{"ok", "1"}})};
}

}  // namespace kvs
