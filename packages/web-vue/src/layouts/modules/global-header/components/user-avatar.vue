<script setup lang="ts">
import { computed } from 'vue';
import type { VNode } from 'vue';
import { $t } from '@/locales';
import { useAuthStore } from '@/store/modules/auth';
import { useSvgIcon } from '@/hooks/common/icon';
import { useRouterPush } from '@/hooks/common/router';
import { AUTH_DISABLED } from '@/constants/auth';

defineOptions({
  name: 'UserAvatar'
});

/**
 * 没有账号体系时，顶栏不显示"登录 / 注册"，也不显示空的用户菜单。
 *
 * 留着一个点进去会失败的登录入口，比什么都不显示更糟：用户会以为是自己
 * 的账号有问题。判断依据与路由守卫同一个常量，避免"守卫关了、按钮还在"。
 */
const showAuthEntries = !AUTH_DISABLED;

const authStore = useAuthStore();
const { routerPushByKey, toLogin } = useRouterPush();
const { SvgIconVNode } = useSvgIcon();

function loginOrRegister() {
  toLogin();
}

type DropdownKey = 'logout';

type DropdownOption =
  | {
      key: DropdownKey;
      label: string;
      icon?: () => VNode;
    }
  | {
      type: 'divider';
      key: string;
    };

const options = computed(() => {
  const opts: DropdownOption[] = [
    {
      label: $t('common.logout'),
      key: 'logout',
      icon: SvgIconVNode({ icon: 'ph:sign-out', fontSize: 18 })
    }
  ];

  return opts;
});

function logout() {
  window.$dialog?.info({
    title: $t('common.tip'),
    content: $t('common.logoutConfirm'),
    positiveText: $t('common.confirm'),
    negativeText: $t('common.cancel'),
    onPositiveClick: () => {
      authStore.resetStore();
    }
  });
}

function handleDropdown(key: DropdownKey) {
  if (key === 'logout') {
    logout();
  } else {
    // If your other options are jumps from other routes, they will be directly supported here
    routerPushByKey(key);
  }
}
</script>

<template>
  <template v-if="showAuthEntries">
    <NButton v-if="!authStore.isLogin" quaternary @click="loginOrRegister">
      {{ $t('page.login.common.loginOrRegister') }}
    </NButton>
    <NDropdown v-else placement="bottom" trigger="click" :options="options" @select="handleDropdown">
      <div>
        <ButtonIcon>
          <SvgIcon icon="ph:user-circle" class="text-icon-large" />
          <span class="text-16px font-medium">{{ authStore.userInfo.userName }}</span>
        </ButtonIcon>
      </div>
    </NDropdown>
  </template>
</template>

<style scoped></style>
