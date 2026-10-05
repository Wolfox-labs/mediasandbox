/**
 * 三类环境预设。每个预设声明：
 *   - 初始目录骨架
 *   - 该环境必须可用的命令（供 doctor 检查，不参与 exec 的成败判定）
 *   - 基线环境变量
 *
 * 本地实现与容器实现共用这份声明，容器侧据此生成 Dockerfile 的安装清单。
 */
import type { EnvType } from './types.js';

export interface EnvPreset {
  readonly envType: EnvType;
  readonly label: string;
  readonly description: string;
  /** create() 时创建的目录（相对 workDir，POSIX 风格）。 */
  readonly directories: readonly string[];
  /** create() 时写入的占位文件（相对 workDir → 内容）。 */
  readonly seedFiles: Readonly<Record<string, string>>;
  /** 该环境期望可用的命令。缺失只记录告警，不让 exec 失败。 */
  readonly requiredCommands: readonly string[];
  /** 该环境的基线环境变量。 */
  readonly baselineEnv: Readonly<Record<string, string>>;
}

const COMMON_ENV: Readonly<Record<string, string>> = {
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_AUDIT: 'false',
  CI: '1',
};

export const ENV_PRESETS: Readonly<Record<EnvType, EnvPreset>> = {
  frontend: {
    envType: 'frontend',
    label: '前端构建环境',
    description: 'Node 工具链：脚手架、依赖安装、构建、静态产物输出到 artifacts/。',
    directories: ['src', 'artifacts', 'logs'],
    seedFiles: {
      'src/.gitkeep': '',
      'artifacts/.gitkeep': '',
    },
    requiredCommands: ['node', 'npm'],
    baselineEnv: { ...COMMON_ENV, NODE_ENV: 'development' },
  },
  image: {
    envType: 'image',
    label: '图像处理环境',
    description: 'Python 图像/视频工具链：Pillow、numpy，外部可选 ffmpeg。',
    directories: ['in', 'out', 'artifacts', 'logs'],
    seedFiles: {
      'in/.gitkeep': '',
      'out/.gitkeep': '',
      'artifacts/.gitkeep': '',
    },
    requiredCommands: ['python'],
    baselineEnv: { ...COMMON_ENV, MPLBACKEND: 'Agg' },
  },
  copy: {
    envType: 'copy',
    label: '文案处理环境',
    description: '文本处理：Markdown/JSON/CSV 的读写与校验，无重依赖。',
    directories: ['drafts', 'artifacts', 'logs'],
    seedFiles: {
      'drafts/.gitkeep': '',
      'artifacts/.gitkeep': '',
    },
    requiredCommands: ['node'],
    baselineEnv: { ...COMMON_ENV },
  },
};

export function getPreset(envType: EnvType): EnvPreset {
  const preset = ENV_PRESETS[envType];
  if (preset === undefined) {
    throw new Error(`未知环境预设: ${String(envType)}`);
  }
  return preset;
}
