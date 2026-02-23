#include "kvs.h"

#include <cctype>
#include <csignal>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>

namespace {
volatile std::sig_atomic_t g_stop = 0; void OnSig(int) { g_stop = 1; }
std::string tr(std::string s){ while(!s.empty()&&std::isspace((unsigned char)s.back())) s.pop_back(); size_t i=0; while(i<s.size()&&std::isspace((unsigned char)s[i])) i++; return s.substr(i);} 
void load_env(const std::string& p){ std::ifstream in(p); if(!in) return; std::string l; while(std::getline(in,l)){ l=tr(l); if(l.empty()||l[0]=='#') continue; if(l.rfind("export ",0)==0) l=tr(l.substr(7)); size_t eq=l.find('='); if(eq==std::string::npos||eq==0) continue; std::string k=tr(l.substr(0,eq)); if(k.empty()||std::getenv(k.c_str())) continue; std::string v=tr(l.substr(eq+1)); if(v.size()>=2&&((v.front()=='"'&&v.back()=='"')||(v.front()=='\''&&v.back()=='\''))) v=v.substr(1,v.size()-2); setenv(k.c_str(),v.c_str(),0);} }
std::string env(const char* k,const char* d){ const char* v=std::getenv(k); return v?v:d; }
int env_i(const char* k,int d){ const char* v=std::getenv(k); if(!v) return d; try{return std::stoi(v);}catch(...){return d;} }
bool env_b(const char* k,bool d){
  const char* v=std::getenv(k); if(!v) return d; std::string s=v;
  for(char& c:s) c=(char)std::tolower((unsigned char)c);
  return s=="1"||s=="true"||s=="yes"||s=="on";
}
}  // namespace

int main(){
  std::signal(SIGINT,OnSig); std::signal(SIGTERM,OnSig);
  const char* ep=std::getenv("ENV_PATH"); if(ep&&*ep) load_env(ep); else { load_env(".env"); load_env("../.env"); load_env("../../.env"); }
  kvs::Config c{
    env("NODE_ID","n1"),
    env_i("KVS_PORT",4000),
    env("DB_PATH","kvs/db"),
    env("CLUSTER_NODES","n1@127.0.0.1:4000"),
    env_b("single_node", env_b("SINGLE_NODE", false)),
    env_i("KVS_RPC_TIMEOUT_MS", 450),
    env_i("KVS_READ_REMOTE_TIMEOUT_MS", 300),
    env_i("KVS_LIST_TITLES_REMOTE_TIMEOUT_MS", 220),
    env_i("KVS_LIST_TITLES_REMOTE_BUDGET_MS", 350),
    env_i("KVS_LIST_TITLES_REMOTE_PER_PEER_LIMIT", 40),
    env_b("KVS_LIST_TITLES_REMOTE_ENABLED", true),
    env_i("KVS_ALIVE_CACHE_MS", 250),
    env_i("KVS_DEAD_CACHE_MS", 80),
    env_i("KVS_ALIVE_PING_TIMEOUT_MS", 120)
  };
  kvs::Engine e(c); if(!e.Start()){ std::cerr<<"kvs start failed\n"; return 1; }
  while(!g_stop) std::this_thread::sleep_for(std::chrono::milliseconds(200));
  e.Stop(); return 0;
}
