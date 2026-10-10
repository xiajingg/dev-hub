'use strict';

// 端口分类：把「一个目录下一堆监听端口」收敛成「这个项目真正在跑的服务端口」。
//
// 实测背景：一个 Electron 桌面应用会开出 4 个随机回环端口（Chromium 内部 IPC，纯噪音）；
// 一个 Java 微服务集群会开出 7~11 个（各服务 + nginx + JMX + 管理端口）。
// 全列出来既没信息量，也看不出重点。

// GUI 应用（Chromium 系）的内部进程 —— 它们监听的端口不是「服务」，绝不作为主端口。
// 注意 lsof 的 COMMAND 列会被截断，所以不做首尾锚定。
const NOISE_PROC = /electron|sandbox-cli|chromium|crashpad|google chrome|chrome helper/i;

// 已知基础设施端口：中间件 / 调试。默认折叠，但用户钉住时仍尊重。
const INFRA_PORTS = new Set([
  1099, // Java RMI
  5005, // JDWP 远程调试
  6379, // Redis
  3306, // MySQL
  5432, // PostgreSQL
  27017, // MongoDB
  9200,
  9300, // Elasticsearch
  2181, // ZooKeeper
  5672, // RabbitMQ
  11211, // Memcached
  9092, // Kafka
  9876, // JMX / Dubbo 注册中心
]);

// 10000 以上多为 JMX / 监控 / 内部管理端口（含系统临时端口段 49152+）。
// 开发服务器极少故意绑在这里 —— 但用户钉住时仍尊重。
const MGMT_MIN = 10000;

// entry: { port, scope, cmd, pid }
//   noise   —— GUI 内部端口，永不作为主端口
//   infra   —— 已知中间件端口，默认折叠
//   mgmt    —— 疑似管理端口，默认折叠
//   service —— 业务服务端口
function classify(entry) {
  if (NOISE_PROC.test(String(entry.cmd || ''))) return 'noise';
  if (INFRA_PORTS.has(entry.port)) return 'infra';
  if (entry.port >= MGMT_MIN) return 'mgmt';
  return 'service';
}

function isNoiseProc(cmd) {
  return NOISE_PROC.test(String(cmd || ''));
}

function uniqSorted(arr) {
  return Array.from(new Set(arr)).sort((a, b) => a - b);
}

// 挑主端口。
// pinnedPort = 用户在编辑里指定的端口。它优先，但「被判为 noise 的」除外 ——
// 那种多半是扫描导入时把 Electron 内部端口误存进来的，不是人的真实意图。
function pick(entries, pinnedPort) {
  const list = entries || [];

  // 当前什么都没在监听 → 退回登记时填的端口
  if (!list.length) {
    return {
      port: pinnedPort || null,
      extra: [],
      all: [],
      hidden: [],
      pinnedListening: false,
      anyNonNoise: false,
    };
  }

  const kinds = list.map((e) => ({ port: e.port, kind: classify(e) }));
  const services = uniqSorted(kinds.filter((k) => k.kind === 'service').map((k) => k.port));
  const others = uniqSorted(
    kinds.filter((k) => k.kind === 'infra' || k.kind === 'mgmt').map((k) => k.port)
  );
  const folded = uniqSorted(kinds.filter((k) => k.kind !== 'service').map((k) => k.port));

  const pinnedEntry = list.find((e) => e.port === pinnedPort);
  const pinnedOk = !!pinnedEntry && classify(pinnedEntry) !== 'noise';

  if (pinnedOk) {
    return {
      port: pinnedPort,
      extra: services.filter((p) => p !== pinnedPort),
      all: services,
      hidden: folded.filter((p) => p !== pinnedPort),
      pinnedListening: true,
      anyNonNoise: true,
    };
  }

  if (services.length) {
    return {
      port: services[0],
      extra: services.slice(1),
      all: services,
      hidden: folded,
      pinnedListening: false,
      anyNonNoise: true,
    };
  }

  // 没有业务端口，但有管理/中间件端口 → 拿它当主端口显示，总比显示「—」有用
  if (others.length) {
    return {
      port: others[0],
      extra: others.slice(1),
      all: [],
      hidden: folded.filter((p) => p !== others[0]),
      pinnedListening: false,
      anyNonNoise: true,
    };
  }

  // 全是 GUI 内部端口 → 没有服务端口可显示
  return {
    port: null,
    extra: [],
    all: [],
    hidden: folded,
    pinnedListening: false,
    anyNonNoise: false,
  };
}

module.exports = { classify, pick, isNoiseProc, NOISE_PROC, INFRA_PORTS, MGMT_MIN };
