<script setup lang="ts">
/**
 * 第 1 步：创作目标。
 *
 * 这一页按顺序问四件事，**每一件都真的参与提交**：
 *
 *   1. 目标描述（必填，空着就不许走）
 *   2. 目标类型 / 模态（网页、图片、文案）
 *   3. 页面元素：从 block 池里挑候选，或新建一个，或干脆跳过
 *   4. 模板：历史模板 / 新建模板 / 空白
 *
 * 只有「网页」需要 3、4 两段：图片与文案不走逐块结构，问了也没有下发的地方。
 * 参数在这一页只**写进 store**，真正提交在下一步（模型决策页）——这样"改了参数
 * 又退回来改"不会打出两次请求。
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NCollapse,
  NCollapseItem,
  NInput,
  NInputNumber,
  NModal,
  NRadio,
  NRadioGroup,
  NSelect,
  NSpin,
  NSwitch,
  NTag,
  useMessage
} from 'naive-ui';
import { api, ApiError, type TemplateItem } from '@/api/client';
import {
  ENV_LABELS,
  UI_ENV_TYPES,
  type BlockGroup,
  type BlockSpecDto
} from '@/api/types';
import { useWorkbenchStore, type SandboxProvider } from '@/store/modules/workbench';

const emit = defineEmits<{ next: [] }>();

const store = useWorkbenchStore();
const message = useMessage();

const ENV_OPTIONS = UI_ENV_TYPES.map(value => ({
  value,
  label: ENV_LABELS[value].label,
  hint: ENV_LABELS[value].hint
}));

const envHint = computed(() => ENV_LABELS[store.envType].hint);

// ── 页面元素（block 池） ────────────────────────────────────────────
const blocks = ref<BlockSpecDto[]>([]);
const groups = ref<{ id: BlockGroup; label: string; count: number }[]>([]);
const blocksLoading = ref(false);
const blocksError = ref<string | undefined>(undefined);

/**
 * 按后端给的 groups 顺序排（内置池是骨架 → 内容 → 交互，和页面从上到下一致）。
 *
 * **不写死三组**：池子里新增一组时，写死的顺序会让那一组在界面上凭空消失。
 * 同时兜住"blocks 里有、groups 里没有"的情况（接口两次查询之间池子变了）。
 */
const groupedBlocks = computed(() => {
  const order = [...groups.value.map(entry => entry.id), ...blocks.value.map(block => block.group)]
    .filter((group, index, list) => list.indexOf(group) === index);
  return order
    .map(group => ({
      group,
      label:
        blocks.value.find(block => block.group === group)?.groupLabel ??
        groups.value.find(entry => entry.id === group)?.label ??
        group,
      items: blocks.value.filter(block => block.group === group)
    }))
    .filter(entry => entry.items.length > 0);
});

const candidateCount = computed(() => store.candidateBlockIds.length);

function isSelected(id: string): boolean {
  return store.candidateBlockIds.includes(id);
}

function groupSelectedAll(entry: { items: BlockSpecDto[] }): boolean {
  return entry.items.length > 0 && entry.items.every(item => isSelected(item.id));
}

async function loadBlocks(): Promise<void> {
  blocksLoading.value = true;
  blocksError.value = undefined;
  try {
    /*
     * 单元池按模态取：网页拿 block 池，演示文稿拿版式池。
     *
     * 两条端点分开是因为后端就是两个注册表——合成一条会让界面以为它们是
     * 同一批东西，而"网页的候选里冒出章节分隔页"正是要防的错。
     * 形状对齐（`blocks`/`layouts` + `groups`），所以这里只在取数处分支，
     * 下面的多选、分组、计数逻辑两种模态共用。
     */
    const pool = store.isSlides
      ? await api.slideLayouts().then(result => ({ blocks: result.layouts, groups: result.groups }))
      : await api.blocks();
    blocks.value = pool.blocks;
    groups.value = pool.groups;
    /*
     * 第一次进池子时默认全选。
     *
     * "默认全选"和"跳过"在提交参数上是**两回事**：全选会把候选集显式传给后端，
     * 跳过则根本不传（后端用当时的池子全集）。默认全选是为了让人先看见池子里
     * 有什么，再决定去掉哪些。
     */
    if (store.candidateBlockIds.length === 0 && !store.poolSkipped) {
      store.candidateBlockIds = pool.blocks.map(block => block.id);
    }
  } catch (error) {
    blocksError.value =
      error instanceof ApiError ? error.message : `加载${store.unitNoun}池失败`;
  } finally {
    blocksLoading.value = false;
  }
}

/**
 * 换模态时**必须换池子并清空已选**。
 *
 * 网页的 block id 与演示文稿的版式 id 在两个池子里，混着提交会被后端直接拒
 * （400：候选集里有未注册的 block/版式）。留着旧选择看起来更"贴心"，
 * 实际是给用户埋一个必失败的提交。
 */
watch(
  () => store.envType,
  () => {
    store.candidateBlockIds = [];
    blocks.value = [];
    groups.value = [];
    if (store.isStructured) void loadBlocks();
  }
);

function toggleBlock(id: string, checked: boolean): void {
  const next = new Set(store.candidateBlockIds);
  if (checked) next.add(id);
  else next.delete(id);
  store.candidateBlockIds = [...next];
}

function toggleGroup(entry: { items: BlockSpecDto[] }, checked: boolean): void {
  const next = new Set(store.candidateBlockIds);
  for (const item of entry.items) {
    if (checked) next.add(item.id);
    else next.delete(item.id);
  }
  store.candidateBlockIds = [...next];
}

function selectAllBlocks(): void {
  store.candidateBlockIds = blocks.value.map(block => block.id);
}

function clearBlocks(): void {
  store.candidateBlockIds = [];
}

/** 新建区块（POST /api/blocks）。成功后就刷新池子并选中它。 */
const blockDialogVisible = ref(false);

// ── 效果预览（元素 / 版式 / 模板共用同一个弹层）────────────────────────
interface UnitPreview {
  readonly title: string;
  readonly url: string;
}

const unitPreview = ref<UnitPreview | undefined>(undefined);

/** 单元预览地址：网页取 block 池，演示文稿取版式池（后端两条端点，不能混）。 */
function unitPreviewUrl(unit: { readonly id: string }): string {
  return store.isSlides ? api.slideLayoutPreviewUrl(unit.id) : api.blockPreviewUrl(unit.id);
}

/**
 * 打开一个单元的"看效果"（放大）。
 *
 * 结果来自后端**确定性渲染**（不调生成层）：示例文案 + 真实版式。
 * 所以弹层里必须写明"文案是示例值"，否则容易被当成这次运行会产出的内容。
 */
function openUnitPreview(unit: { readonly id: string; readonly label: string }): void {
  unitPreview.value = { title: unit.label, url: unitPreviewUrl(unit) };
}

function openTemplatePreview(template: { readonly id: string; readonly label: string }): void {
  unitPreview.value = { title: template.label, url: api.templatePreviewUrl(template.id) };
}
const creatingBlock = ref(false);
const createBlockError = ref<string | undefined>(undefined);
const newBlock = ref<{ id: string; label: string; group: BlockGroup; description: string }>({
  id: '',
  label: '',
  group: 'content',
  description: ''
});

const BLOCK_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function openBlockDialog(): void {
  newBlock.value = { id: '', label: '', group: 'content', description: '' };
  createBlockError.value = undefined;
  blockDialogVisible.value = true;
}

async function createBlock(): Promise<void> {
  const draft = newBlock.value;
  const id = draft.id.trim();
  const label = draft.label.trim();
  if (!BLOCK_ID_PATTERN.test(id)) {
    createBlockError.value = 'id 只允许小写字母开头，后接小写字母、数字与连字符（例：price-table）';
    return;
  }
  if (label === '') {
    createBlockError.value = '显示名不能为空';
    return;
  }
  creatingBlock.value = true;
  createBlockError.value = undefined;
  try {
    const result = await api.createBlock({
      id,
      label,
      description: draft.description.trim() === '' ? label : draft.description.trim(),
      group: draft.group,
      canLead: false,
      repeatable: true,
      costHint: 'fast',
      // 最小可用形态：一个必填文本 slot。更复杂的 slot 形态到区块管理里改。
      slots: [{ name: 'text', type: 'text', required: true, description: label }]
    });
    message.success(`已加入区块池：${result.block.id}`);
    blockDialogVisible.value = false;
    await loadBlocks();
    // 新建的目的就是要用它：建完直接勾上，省一次点击。
    if (!isSelected(result.block.id)) {
      store.candidateBlockIds = [...store.candidateBlockIds, result.block.id];
    }
  } catch (error) {
    createBlockError.value = error instanceof ApiError ? error.message : '新建区块失败';
  } finally {
    creatingBlock.value = false;
  }
}

// ── 模板 ────────────────────────────────────────────────────────────
const templates = ref<TemplateItem[]>([]);
const templatesError = ref<string | undefined>(undefined);
const templatesLoading = ref(false);

const templateOptions = computed(() =>
  templates.value.map(template => ({
    label: `${template.label}${template.builtin ? '' : '（自建）'}`,
    value: template.id
  }))
);

const selectedTemplate = computed(() =>
  templates.value.find(template => template.id === store.templateId)
);

async function loadTemplates(): Promise<void> {
  templatesLoading.value = true;
  templatesError.value = undefined;
  try {
    const result = await api.templates();
    templates.value = result.templates;
  } catch (error) {
    templates.value = [];
    templatesError.value = error instanceof ApiError ? error.message : '加载模板池失败';
  } finally {
    templatesLoading.value = false;
  }
}

const templateDialogVisible = ref(false);
const creatingTemplate = ref(false);
const createTemplateError = ref<string | undefined>(undefined);

/** 新建模板的起手结构 = 现在勾选的候选块。没勾就建不出来（后端也会拒）。 */
const templateDraftBlockCount = computed(() => store.candidateBlockIds.length);

function openTemplateDialog(): void {
  if (store.newTemplateLabel.trim() === '') store.newTemplateLabel = store.goal.trim().slice(0, 20);
  createTemplateError.value = undefined;
  templateDialogVisible.value = true;
}

async function createTemplate(): Promise<void> {
  const label = store.newTemplateLabel.trim();
  if (label === '') {
    createTemplateError.value = '模板名不能为空';
    return;
  }
  if (store.candidateBlockIds.length === 0) {
    createTemplateError.value = '先在「页面元素」里选几块，再拿它们组模板';
    return;
  }
  creatingTemplate.value = true;
  createTemplateError.value = undefined;
  try {
    const created = await api.createTemplate({
      label,
      description: store.newTemplateDescription.trim(),
      blocks: store.candidateBlockIds.map(type => ({ type }))
    });
    await loadTemplates();
    /*
     * 建好之后**切到「历史模板」并选中它**。
     *
     * 后端只有"给 templateId 就按它的起手结构排"这一条路，没有"用刚建的那个"；
     * 不切过去的话，这次运行其实没套上模板，而用户以为套上了。
     */
    store.markTemplateSaved(created.template.id);
    templateDialogVisible.value = false;
    message.success(`已保存模板：${created.template.label}（这次运行会用它）`);
  } catch (error) {
    createTemplateError.value = error instanceof ApiError ? error.message : '新建模板失败';
  } finally {
    creatingTemplate.value = false;
  }
}

// ── 高级参数 ────────────────────────────────────────────────────────
const providerOptions: { label: string; value: SandboxProvider }[] = [
  { label: 'docker（容器级隔离）', value: 'docker' },
  { label: 'local（路径级隔离）', value: 'local' }
];

function onProviderChange(value: string | number | null): void {
  if (value === 'docker' || value === 'local') store.setProvider(value);
}

function onMaxBlocksChange(value: number | null): void {
  if (typeof value === 'number' && value > 0) store.maxBlocks = Math.round(value);
}

// ── 提交前自检 ──────────────────────────────────────────────────────
const summary = computed(() => {
  const parts: string[] = [store.envLabel];
  // 结构化的两种模态都有"候选单元"这一档。模板只有网页有（模板池按 block 建）。
  if (store.isStructured) {
    parts.push(
      store.poolSkipped
        ? `候选${store.unitNoun}由模型决定`
        : `${candidateCount.value} 个候选${store.unitNoun}`
    );
  }
  if (store.isWebpage) {
    if (store.templateMode === 'saved' && selectedTemplate.value !== undefined) {
      parts.push(`模板：${selectedTemplate.value.label}`);
    } else if (store.templateMode === 'new') {
      parts.push('新模板未保存');
    } else {
      parts.push('不套模板');
    }
  }
  return parts.join(' · ');
});

function goNext(): void {
  if (!store.canGoNext) return;
  emit('next');
}

onMounted(async () => {
  // 只有结构化模态才有"单元池"要挑；模板池是按 block 建的，只对网页有意义。
  // 无差别地拉一遍会在图像/文案模态上打出一个无关的 503。
  await Promise.all([
    store.isStructured ? loadBlocks() : Promise.resolve(),
    store.isWebpage ? loadTemplates() : Promise.resolve()
  ]);
  try {
    const health = await api.health();
    store.adoptDefaultProvider(health.defaultProvider);
  } catch {
    // 连不上时保持当前选择；提交会给出更准确的原因。
  }
});
</script>

<template>
  <div class="wb__stack">
    <div class="wb__head">
      <span class="wb__title">创作目标</span>
      <span class="wb__sub">{{ envHint }}</span>
    </div>

    <NCard size="small" :bordered="false" class="wb__card">
      <template #header>
        <span class="wb__no">1</span>
        <span>要做什么</span>
      </template>

      <!-- ① 目标描述 -->
      <label class="wb__field">
        <span class="wb__label">目标描述（必填）</span>
        <NInput
          v-model:value="store.goal"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          placeholder="例如：做一个中文产品介绍落地页，讲清价格与三个卖点，末尾给行动号召"
        />
        <span class="wb__hint wb__hint--block">
          一句话说清"给谁看、要讲什么、看完做什么"。这句会原样交给决策模型。
        </span>
      </label>

      <!-- ② 目标类型 -->
      <div class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">目标类型</span>
          <span class="wb__section-count">网页与演示文稿才需要挑{{ store.unitNoun }}</span>
        </div>
        <NRadioGroup v-model:value="store.envType" class="wb__radios">
          <NRadio v-for="option in ENV_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
            <span class="wb__radio-hint">{{ option.hint }}</span>
          </NRadio>
        </NRadioGroup>
      </div>

      <!-- ③ 单元池：网页是页面区块，演示文稿是每页的版式 -->
      <div v-if="store.isStructured" class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">
            {{ store.isSlides ? '版式（每页一个）' : '页面元素' }}
          </span>
          <span class="wb__section-count">
            {{ candidateCount }} / {{ blocks.length }}
            {{ store.poolMode === 'seed' ? '已点名' : '已选' }}
          </span>
          <span class="wb__actions-fill" />
          <NButton text size="tiny" :disabled="blocks.length === 0" @click="selectAllBlocks">
            全选
          </NButton>
          <NButton text size="tiny" :disabled="candidateCount === 0" @click="clearBlocks">
            清空
          </NButton>
          <!-- 版式池是内置的固定 8 个，没有"新建版式"这条接口，所以不给按钮 -->
          <NButton v-if="store.isWebpage" text size="tiny" @click="openBlockDialog">
            新建区块
          </NButton>
        </div>

        <NAlert v-if="blocksError" type="error" :bordered="false" class="mb-2">
          {{ blocksError }}
        </NAlert>

        <!-- 勾选的两种含义（两种都支持）：限定候选范围 / 指定起手块 -->
        <div class="wb__field">
          <NRadioGroup v-model:value="store.poolMode" size="small" class="wb__radios">
            <NRadio value="candidate">限定候选范围</NRadio>
            <NRadio value="seed">指定起手块</NRadio>
          </NRadioGroup>
          <span class="wb__hint">
            {{
              store.poolMode === 'seed'
                ? `勾中的会被先铺上——这几${store.unitNoun}一定用上，其余仍由模型在整池里决定。`
                : `勾中的只是候选范围：模型只能在这些${store.unitNoun}里选，选不选、选几个仍由它定。`
            }}
          </span>
        </div>

        <div v-if="store.poolMode === 'candidate'" class="wb__field">
          <NSwitch v-model:value="store.poolSkipped">
            <template #checked>跳过这次选择</template>
            <template #unchecked>跳过这次选择</template>
          </NSwitch>
          <span class="wb__hint">
            {{
              store.poolSkipped
                ? `本次不限定候选${store.unitNoun}：${store.unitNoun}怎么排完全交给模型。`
                : `勾上就不限定候选${store.unitNoun}，等于把"用哪几个${store.unitNoun}"的决定权全部交给模型。`
            }}
          </span>
        </div>

        <NSpin :show="blocksLoading">
          <div v-if="blocks.length === 0 && !blocksLoading && !blocksError" class="wb__empty">
            {{
              store.isSlides
                ? '版式池是空的：这次部署没装配演示文稿版式'
                : '区块池是空的，点右上角「新建区块」建一个'
            }}
          </div>
          <div v-for="entry in groupedBlocks" :key="entry.group" class="wb__group">
            <div class="wb__group-head">
              <span>{{ entry.label }}</span>
              <span class="wb__section-count">
                {{ entry.items.filter(item => isSelected(item.id)).length }} / {{ entry.items.length }}
              </span>
              <span class="wb__actions-fill" />
              <NButton
                text
                size="tiny"
                :disabled="store.poolSkipped"
                @click="toggleGroup(entry, !groupSelectedAll(entry))"
              >
                {{ groupSelectedAll(entry) ? '清空本组' : '全选本组' }}
              </NButton>
            </div>
            <!-- 每个单元一张卡片：缩略图里是**真实渲染出来的效果**，点图放大；
                 勾选仍走下面的复选框（缩略图上 pointer-events 关掉，免得点穿）。 -->
            <div class="wb__units">
              <div
                v-for="block in entry.items"
                :key="block.id"
                class="wb__unit"
                :class="{ 'wb__unit--on': isSelected(block.id) && !store.poolSkipped }"
              >
                <div
                  class="wb__unit-thumb"
                  role="button"
                  tabindex="0"
                  :title="`放大看「${block.label}」（${block.id}）`"
                  @click="openUnitPreview(block)"
                  @keydown.enter="openUnitPreview(block)"
                >
                  <iframe
                    :src="unitPreviewUrl(block)"
                    class="wb__unit-thumb-frame"
                    sandbox="allow-scripts"
                    loading="lazy"
                    scrolling="no"
                    tabindex="-1"
                  />
                  <!-- 角标压在图里，脚下只留"勾选 + 名字"，卡片才压得住 -->
                  <span v-if="block.costHint === 'slow'" class="wb__unit-badge">慢</span>
                  <span v-if="!block.repeatable" class="wb__unit-badge wb__unit-badge--right">
                    仅一次
                  </span>
                  <span class="wb__unit-zoom">放大</span>
                </div>
                <div class="wb__unit-foot">
                  <NCheckbox
                    :checked="isSelected(block.id)"
                    :disabled="store.poolSkipped"
                    size="small"
                    @update:checked="checked => toggleBlock(block.id, checked)"
                  >
                    {{ block.label }}
                    <span class="wb__block-id">{{ block.id }}</span>
                  </NCheckbox>
                </div>
              </div>
            </div>
          </div>
        </NSpin>
      </div>

      <!-- 模块库：网页有模板，演示文稿没有。**说明白为什么没有**，而不是悄悄少一块 -->
      <div v-if="store.isSlides" class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">模块库</span>
          <span class="wb__section-count">演示文稿没有模板，页序与版式由决策模型逐页定</span>
        </div>
        <span class="wb__hint wb__hint--block">
          模板池是按网页区块建的（doc-page / faq-page / product-launch / showcase），
          套到幻灯片上没有意义。演示文稿的模块库就是上面那个版式池：
          挑好这次能用的版式，先后顺序交给模型。
        </span>
      </div>

      <!-- ④ 模板：只对网页有意义（模板池是按 block 建的） -->
      <div v-if="store.isWebpage" class="wb__section">
        <div class="wb__section-head">
          <span class="wb__label" style="margin: 0">模板</span>
          <span class="wb__section-count">模板决定起手那几块是现成的</span>
        </div>

        <NRadioGroup v-model:value="store.templateMode" class="wb__radios">
          <NRadio value="saved">历史模板</NRadio>
          <NRadio value="new">新建模板</NRadio>
          <NRadio value="blank">空白模板</NRadio>
        </NRadioGroup>

        <!-- 历史模板 -->
        <div v-if="store.templateMode === 'saved'" class="wb__template-body">
          <NSpin :show="templatesLoading" size="small">
            <NSelect
              v-model:value="store.templateId"
              size="small"
              clearable
              placeholder="从模板池里挑一套"
              :options="templateOptions"
            />
            <NAlert v-if="templatesError" type="warning" :bordered="false" class="mt-2">
              {{ templatesError }}
            </NAlert>
            <span v-else-if="templates.length === 0" class="wb__hint wb__hint--block">
              模板池是空的，可以先用「空白模板」跑一次，或在这里新建一套。
            </span>
            <div v-if="selectedTemplate" class="wb__template-preview">
              <p class="wb__note" style="margin: 8px 0 4px">
                {{ selectedTemplate.description }}
              </p>
              <div class="wb__bp-blocks">
                <NTag v-for="item in selectedTemplate.blocks" :key="item.type" size="tiny">
                  {{ item.type }}
                </NTag>
              </div>
              <span v-if="selectedTemplate.allowedBlockIds" class="wb__hint wb__hint--block">
                这套模板还会把候选块限定在 {{ selectedTemplate.allowedBlockIds.length }} 个类型内。
              </span>
              <!-- 模板样例同样要看得见：缩略图是真渲染，点它放大 -->
              <div class="wb__template-shot">
                <div
                  class="wb__unit-thumb wb__unit-thumb--wide"
                  role="button"
                  tabindex="0"
                  :title="`放大看模板「${selectedTemplate.label}」`"
                  @click="openTemplatePreview(selectedTemplate)"
                  @keydown.enter="openTemplatePreview(selectedTemplate)"
                >
                  <iframe
                    :src="api.templatePreviewUrl(selectedTemplate.id)"
                    class="wb__unit-thumb-frame wb__unit-thumb-frame--wide"
                    sandbox="allow-scripts"
                    loading="lazy"
                    scrolling="no"
                    tabindex="-1"
                  />
                  <span class="wb__unit-zoom">放大</span>
                </div>
                <span class="wb__hint wb__hint--block">
                  模板样例：示例内容下的起手结构与版式（确定性渲染，不调生成层）。
                </span>
              </div>
            </div>
          </NSpin>
        </div>

        <!-- 新建模板 -->
        <div v-else-if="store.templateMode === 'new'" class="wb__template-body">
          <NButton size="small" secondary @click="openTemplateDialog">
            {{ store.templateSaved ? '再建一套模板' : '填写模板信息' }}
          </NButton>
          <span class="wb__hint wb__hint--block">
            新模板的起手结构就是上面勾选的 {{ templateDraftBlockCount }} 个块。保存后会切到
            「历史模板」并选中它，这次运行就用它。
          </span>
        </div>

        <!-- 空白模板 -->
        <div v-else class="wb__template-body">
          <span class="wb__hint wb__hint--block" style="margin-left: 0">
            不套模板：结构从零开始，由决策模型逐块决定。
          </span>
        </div>
      </div>

      <!-- 高级参数 -->
      <NCollapse v-if="store.isStructured" class="wb__section">
        <NCollapseItem
          :title="`高级参数（${store.isSlides ? '页数' : '区块'}上限、品牌、生成开关、沙盒）`"
          name="advanced"
        >
          <div class="wb__row">
            <label class="wb__field wb__field--half">
              <span class="wb__label">
                {{ store.isSlides ? '页数上限' : '页面区块数上限' }}
              </span>
              <NInputNumber
                :value="store.maxBlocks"
                size="small"
                :min="1"
                :max="24"
                @update:value="onMaxBlocksChange"
              />
            </label>
            <label class="wb__field wb__field--half">
              <span class="wb__label">品牌名（可留空）</span>
              <NInput v-model:value="store.brand" size="small" placeholder="例如 MediaSandbox" />
            </label>
          </div>
          <div class="wb__row">
            <label class="wb__field wb__field--half">
              <span class="wb__label">沙盒</span>
              <NSelect
                :value="store.provider"
                size="small"
                :options="providerOptions"
                @update:value="onProviderChange"
              />
            </label>
            <div class="wb__field wb__field--half">
              <span class="wb__label">开关</span>
              <div class="wb__switches">
                <NSwitch v-model:value="store.useGenerative" size="small">
                  <template #checked>文案走生成层</template>
                  <template #unchecked>文案走生成层</template>
                </NSwitch>
                <NSwitch v-if="store.isWebpage" v-model:value="store.annotate" size="small">
                  <template #checked>标注每块来源</template>
                  <template #unchecked>标注每块来源</template>
                </NSwitch>
                <NSwitch v-model:value="store.screenshot" size="small">
                  <template #checked>{{ store.isSlides ? '首页截图' : '产出页面截图' }}</template>
                  <template #unchecked>{{ store.isSlides ? '首页截图' : '产出页面截图' }}</template>
                </NSwitch>
              </div>
              <span class="wb__hint wb__hint--block">
                「文案走生成层」默认关：开了才会按次调用生成模型。统筹规划不受它控制——
                配了生成层就会跑一次。
              </span>
            </div>
          </div>
        </NCollapseItem>
      </NCollapse>

      <!-- 下一步 -->
      <div class="wb__actions">
        <NButton type="primary" :disabled="!store.canGoNext" @click="goNext">下一步：模型决策</NButton>
        <span class="wb__hint">本次会提交：{{ summary }}</span>
      </div>
      <NAlert v-if="store.goalBlocker" type="default" :bordered="false" class="mt-2">
        {{ store.goalBlocker }}
      </NAlert>
    </NCard>

    <!-- 新建区块 -->
    <NModal
      v-model:show="blockDialogVisible"
      preset="card"
      title="新建区块"
      style="width: 480px; max-width: calc(100vw - 32px)"
    >
      <div class="wb__dialog">
        <label class="wb__field">
          <span class="wb__label">id（进 HTML 属性与文件名，小写字母开头，可含数字与连字符）</span>
          <NInput v-model:value="newBlock.id" size="small" placeholder="例如 price-table" />
        </label>
        <label class="wb__field">
          <span class="wb__label">显示名</span>
          <NInput v-model:value="newBlock.label" size="small" placeholder="例如 价格表" />
        </label>
        <label class="wb__field">
          <span class="wb__label">分组</span>
          <NSelect
            v-model:value="newBlock.group"
            size="small"
            :options="[
              { label: '页面骨架', value: 'skeleton' },
              { label: '内容块', value: 'content' },
              { label: '交互块', value: 'interactive' }
            ]"
          />
        </label>
        <label class="wb__field">
          <span class="wb__label">说明（留空就用显示名）</span>
          <NInput v-model:value="newBlock.description" size="small" />
        </label>
        <span class="wb__hint wb__hint--block">
          新建的区块先带一个必填文本 slot；更复杂的 slot 声明到区块管理里改。建完会直接勾上。
        </span>
        <NAlert v-if="createBlockError" type="error" :bordered="false" class="mt-2">
          {{ createBlockError }}
        </NAlert>
        <div class="wb__dialog-actions">
          <NButton size="small" @click="blockDialogVisible = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creatingBlock" @click="createBlock">
            创建并选用
          </NButton>
        </div>
      </div>
    </NModal>

    <!-- 新建模板 -->
    <NModal
      v-model:show="templateDialogVisible"
      preset="card"
      title="新建模板"
      style="width: 480px; max-width: calc(100vw - 32px)"
    >
      <div class="wb__dialog">
        <label class="wb__field">
          <span class="wb__label">模板名</span>
          <NInput v-model:value="store.newTemplateLabel" size="small" placeholder="例如 产品落地页·三段式" />
        </label>
        <label class="wb__field">
          <span class="wb__label">说明（可留空）</span>
          <NInput
            v-model:value="store.newTemplateDescription"
            size="small"
            placeholder="这套结构适合什么场景"
          />
        </label>
        <span class="wb__hint wb__hint--block">
          起手结构 = 当前勾选的 {{ templateDraftBlockCount }} 个块（按选择顺序）。
        </span>
        <NAlert v-if="createTemplateError" type="error" :bordered="false" class="mt-2">
          {{ createTemplateError }}
        </NAlert>
        <div class="wb__dialog-actions">
          <NButton size="small" @click="templateDialogVisible = false">取消</NButton>
          <NButton size="small" type="primary" :loading="creatingTemplate" @click="createTemplate">
            保存模板
          </NButton>
        </div>
      </div>
    </NModal>

    <!-- 效果预览：后端确定性渲染的 HTML 直接进 iframe；不调生成层、不花 token -->
    <NModal
      :show="unitPreview !== undefined"
      preset="card"
      :title="unitPreview?.title ?? '效果预览'"
      style="width: min(1000px, calc(100vw - 32px))"
      @update:show="
        value => {
          if (!value) unitPreview = undefined;
        }
      "
    >
      <template v-if="unitPreview" #header-extra>
        <a :href="unitPreview.url" target="_blank" rel="noreferrer" class="wb__preview-open">
          在新标签打开
        </a>
      </template>
      <div class="wb__unit-preview">
        <iframe
          v-if="unitPreview"
          :src="unitPreview.url"
          class="wb__unit-frame"
          sandbox="allow-scripts"
          title="效果预览"
        />
      </div>
      <p class="wb__hint">
        这是示例内容下的效果（后端确定性渲染，不调生成层）；真实运行中的文案由模型填。
      </p>
    </NModal>
  </div>
</template>

<style scoped>
/* 这一页只多一个间距规则，其余视觉全在 modules/workbench.css 里 */
.wb__template-preview {
  margin-top: 2px;
}
</style>
