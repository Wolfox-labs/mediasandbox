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
  // 结构化制作链路。与 frontend 的差别不在工具链（同样是 Node + 静态产物），
  // 而在**粒度**：frontend 下工具是交付物级（整页），这里工具是 block 级。
  // 保留独立目录骨架是刻意的——block 的中间结构落在 src/blocks/ 下，
  // 与整页生成的 src/index.html 不会互相覆盖，两条链路可以同时跑。
  webpage: {
    envType: 'webpage',
    label: '结构化网页环境',
    description:
      '按 block 组装网页：结构由决策模型逐块决定，素材逐块填充，产物为整页 HTML。',
    directories: ['src', 'src/blocks', 'artifacts', 'logs'],
    seedFiles: {
      'src/blocks/.gitkeep': '',
      'artifacts/.gitkeep': '',
    },
    requiredCommands: ['node'],
    baselineEnv: { ...COMMON_ENV, NODE_ENV: 'development' },
  },
  // 演示文稿链路。目录骨架与 webpage 的区别是 **src/slides/**：
  // 每一页的中间结构单独落一个文件，与整页 HTML 的 src/blocks/ 不冲突，
  // 两条结构化链路可以同时跑在同一个沙盒里而不互相覆盖。
  slides: {
    envType: 'slides',
    label: '演示文稿环境',
    description:
      '按版式组装 16:9 演示文稿：页序与每页版式由决策模型逐页决定，素材逐页填充，产物为可放映的一页一屏 HTML。',
    directories: ['src', 'src/slides', 'artifacts', 'logs'],
    seedFiles: {
      'src/slides/.gitkeep': '',
      'artifacts/.gitkeep': '',
    },
    requiredCommands: ['node'],
    baselineEnv: { ...COMMON_ENV, NODE_ENV: 'development' },
  },
};

export function getPreset(envType: EnvType): EnvPreset {
  const preset = ENV_PRESETS[envType];
  if (preset === undefined) {
    throw new Error(`未知环境预设: ${String(envType)}`);
  }
  return preset;
}
