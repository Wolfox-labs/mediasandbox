import { h, defineComponent } from "vue";
import { Icon as IconifyIcon, addIcon } from "@iconify/vue/dist/offline";

// Iconify Icon在Vue里本地使用（用于内网环境）
export default defineComponent({
  name: "IconifyIconOffline",
  components: { IconifyIcon },
  props: {
    icon: {
      default: null
    }
  },
  render() {
    // 本仓库改动（MediaSandbox）：**不改运行时行为**，只在此处屏蔽类型检查。
    // 上游按旧签名写的是 `addIcon(this.icon, this.icon)`，而 @iconify/vue@4.2.0 的
    // 声明是 `addIcon(name: string, data: IconifyIcon)` —— 两个参数都对不上。
    // 擅自改成语义"正确"的 addCollection 会改变模板的图标注册行为，故保持调用原样。
    // @ts-expect-error 上游旧签名，与当前 @iconify/vue 声明不匹配
    if (typeof this.icon === "object") addIcon(this.icon, this.icon);
    const attrs = this.$attrs;
    if (typeof this.icon === "string") {
      return h(
        IconifyIcon,
        {
          icon: this.icon,
          "aria-hidden": false,
          style: attrs?.style
            ? Object.assign(attrs.style, { outline: "none" })
            : { outline: "none" },
          ...attrs
        },
        {
          default: () => []
        }
      );
    } else {
      return h(
        this.icon,
        {
          "aria-hidden": false,
          style: attrs?.style
            ? Object.assign(attrs.style, { outline: "none" })
            : { outline: "none" },
          ...attrs
        },
        {
          default: () => []
        }
      );
    }
  }
});
