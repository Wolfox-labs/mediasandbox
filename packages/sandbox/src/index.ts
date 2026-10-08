export * from './types.js';
export { ENV_PRESETS, getPreset, type EnvPreset } from './env-presets.js';
export { LocalSandbox, type LocalSandboxOptions } from './local/local-sandbox.js';
export { defineProviderSuite, type ProviderSuiteOptions } from './testing/provider-suite.js';
export {
  runCommand,
  OutputBuffer,
  defaultShell,
  killTree,
  type RunCommandOptions,
} from './util/proc.js';
export { matchesGlob, compileGlob } from './util/glob.js';
export { mimeHintFor } from './util/mime.js';
export {
  isDeliverableArtifact,
  isPlaceholderFile,
} from './util/artifacts.js';
export { assertValidProjectId, resolveInside, toPosixRelative } from './util/paths.js';

// ── Docker 实现 ───────────────────────────────────────────────────────────
// 导出类型与实现，但不导入 dockerode——它是可选依赖，只有真正用 Docker 时才装。
// 调用方自己 `import Docker from 'dockerode'` 并传进 DockerSandboxOptions.docker。
export {
  DockerSandbox,
  IMAGE_BY_ENV,
  parseMemory,
  type DockerSandboxOptions,
} from './docker/docker-sandbox.js';
export {
  DEFAULT_LIMITS,
  type DockerApi,
  type DockerContainer,
  type DockerLimits,
  type ResolvedDockerLimits,
} from './docker/docker-api.js';
// 附流的两套帧格式单独导出：它是纯字节处理，可脱离 Docker 测，
// 也是"接容器长驻进程"时必须自己接对的那一层。
export {
  FRAME_HEADER_BYTES,
  STREAM_STDIN,
  STREAM_STDOUT,
  STREAM_STDERR,
  createDemuxer,
  frameStdin,
  type Demuxer,
  type DemuxerOptions,
} from './docker/stream-frames.js';
