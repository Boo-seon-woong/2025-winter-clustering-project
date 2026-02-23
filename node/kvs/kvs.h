#pragma once

#include <atomic>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace kvs {

struct NodeInfo { std::string id, host; int port = 0; };
struct Config {
  std::string node_id;
  int port = 4000;
  std::string db_path;
  std::string cluster_nodes;
  bool single_node = false;
  int rpc_timeout_ms = 450;
  int read_remote_timeout_ms = 300;
  int list_titles_remote_timeout_ms = 220;
  int list_titles_remote_budget_ms = 350;
  int list_titles_remote_per_peer_limit = 40;
  bool list_titles_remote_enabled = true;
  int alive_cache_ms = 250;
  int dead_cache_ms = 80;
  int alive_probe_timeout_ms = 120;
};

class Engine {
 public:
  struct Req { std::string method, path, body; };
  struct Resp { int status = 500; std::string body; };
  explicit Engine(Config cfg); ~Engine();
  bool Start(); void Stop();

 private:
  struct Post { std::string id, account_id, title, content; long created_at = 0; };
  bool InitDb(); void CloseDb(); void Serve(); Resp Handle(const Req&);
  Resp CreateAccount(const Req&); Resp GetAccount(const Req&); Resp CreatePost(const Req&); Resp GetPost(const Req&); Resp ListTitles(const Req&);
  Resp PutAccountInternal(const Req&); Resp GetAccountInternal(const Req&); Resp PutPostInternal(const Req&); Resp GetPostInternal(const Req&); Resp ListTitlesInternal(const Req&); Resp Ping();
  bool PutAccount(const std::string&, const std::string&, const std::string&, long, bool, bool*);
  bool ReadAccount(const std::string&, std::string*, std::string*, long*);
  bool PutPost(const Post&, bool, bool*); bool ReadPost(const std::string&, Post*); std::vector<Post> LocalTitles(int limit = 0);
  std::vector<NodeInfo> PostOwners(const std::string&, bool);
  struct AliveMemo { bool alive = false; long expires_at = 0; };
  bool LookupAliveMemo(const NodeInfo&, bool*);
  void StoreAliveMemo(const NodeInfo&, bool);
  bool Alive(const NodeInfo&); bool Call(const NodeInfo&, const std::string&, const std::string&, int*, std::string*, int timeout_ms = 0);

  Config cfg_; std::vector<NodeInfo> nodes_;
  void* db_ = nullptr; void* def_cf_ = nullptr; void* acc_cf_ = nullptr; void* post_cf_ = nullptr; std::vector<void*> cfs_;
  std::mutex mu_; std::mutex alive_mu_; std::map<std::string, AliveMemo> alive_memo_;
  std::atomic<bool> stop_{false}; int listen_fd_ = -1; std::thread th_;
};

}  // namespace kvs
