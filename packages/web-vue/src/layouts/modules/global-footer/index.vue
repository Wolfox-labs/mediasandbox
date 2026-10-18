<script setup lang="ts">
defineOptions({
  name: 'GlobalFooter'
});

/**
 * 页脚。
 *
 * 模板原本是 "Copyright MIT © 2021 Soybean" 并外链到 soybean-admin 的 LICENSE，
 * 那是模板作者的信息。本项目是 MediaSandbox 的前端，页脚指向本项目；
 * 模板许可与出处在 `packages/web-vue/README.soybean-admin.md` 里保留。
 */
const year = new Date().getFullYear();
</script>

<template>
  <DarkModeContainer class="h-full flex-center">
    <span>MediaSandbox · MIT · {{ year }}</span>
  </DarkModeContainer>
</template>

<style scoped></style>
