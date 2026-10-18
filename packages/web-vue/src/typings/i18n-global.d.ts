/**
 * `$t` 在模板里的全局类型声明。
 *
 * ## 为什么需要这个文件
 *
 * soybean-admin 的模板代码里大量用 `$t('route.home')` 这种全局注入的翻译函数
 * （vue-i18n 的 `globalInjection: true`）。运行时它存在，但**类型上没有声明**：
 * `src/typings/app.d.ts` 里只定义了 `interface $T`（函数签名），
 * 没有把它挂到 `ComponentCustomProperties` 上。
 *
 * 于是 `vue-tsc` 会对所有模板文件报：
 *
 *   error TS2339: Property '$t' does not exist on type 'ComponentPublicInstance<...>'
 *
 * 这不是本项目引入的问题（`views/home/index.vue` 等模板自带页面同样报错），
 * 但类型检查常年飘红会让人忽略真正的新错误，所以在这里补上。
 *
 * 声明成 `$T` 而不是宽松的 `(key: string) => string`：保留 key 的联合类型约束，
 * 写错 i18n key 时仍能在编译期发现。
 */
import type { $T } from 'vue-i18n';

declare module '@vue/runtime-core' {
  interface ComponentCustomProperties {
    /** 全局注入的翻译函数（vue-i18n `globalInjection`）。 */
    $t: $T;
    /** 全局注入的复数翻译函数。 */
    $tc: $T;
    /** 全局注入的数值格式化。 */
    $n: (value: number) => string;
    /** 全局注入的日期格式化。 */
    $d: (value: Date | number) => string;
  }
}

export {};
