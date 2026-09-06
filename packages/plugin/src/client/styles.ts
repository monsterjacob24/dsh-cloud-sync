/**
 * 卡片样式与注入器：不用 CSS modules（外部包没有 tsdown 的虚拟模块管线），
 * 改为「样式文本 + 带 data-plugin 标记的 <style> 注入器」，思路仿
 * deepseek-harness packages/client/tsdown.client.ts 的 styleInjectionModule 简化版。
 * 颜色全部走 dsw token（--dsw-alias-*），类名统一 dsh-cloud-sync-card 前缀防撞名。
 */

/** 样式文本。 */
export const CARD_CSS = `
.dsh-cloud-sync-card {
  list-style: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-cloud-sync-card__header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
}
.dsh-cloud-sync-card__name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-card__description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__body {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 0 16px;
  padding: 4px 0 12px;
}
.dsh-cloud-sync-card__section {
  padding: 12px 0 0;
}
.dsh-cloud-sync-card__section + .dsh-cloud-sync-card__section {
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin-top: 12px;
}
.dsh-cloud-sync-card__section-title {
  margin: 0 0 4px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0;
}
.dsh-cloud-sync-card__field-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-cloud-sync-card__label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-card__badge {
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
  font-weight: 500;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-card__badge--muted {
  background: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  height: 34px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-card__input::placeholder {
  color: var(--dsw-alias-label-dimmed);
}
.dsh-cloud-sync-card__input:focus-visible {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-cloud-sync-card__input:disabled {
  color: var(--dsw-alias-label-tertiary);
  cursor: default;
}
.dsh-cloud-sync-card__input[aria-invalid='true'] {
  border-color: var(--dsw-alias-label-error);
}
/* secret 行：外框是视觉控件（焦点环落在行上），输入框裸嵌、👁 收进框内。
   注意输入框自身不能再带 flex: 1 —— 在纵向 flex 容器里 flex-basis: 0%
   会把高度压没（M3 验收实测 text 输入塌到 15px），只能放在横向行里用。 */
.dsh-cloud-sync-card__input-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  box-sizing: border-box;
  padding: 0 6px 0 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-cloud-sync-card__input-row:focus-within {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-cloud-sync-card__input-row .dsh-cloud-sync-card__input {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: none;
  background: transparent;
}
.dsh-cloud-sync-card__input-row .dsh-cloud-sync-card__input:focus-visible {
  border: none;
}
.dsh-cloud-sync-card__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__error {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-error);
}
.dsh-cloud-sync-card__icon-button {
  flex: none;
  appearance: none;
  border: none;
  background: none;
  padding: 4px;
  font: inherit;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  border-radius: 6px;
}
.dsh-cloud-sync-card__icon-button:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-card__icon-button:disabled {
  cursor: default;
  opacity: 0.4;
}
.dsh-cloud-sync-card__row-end {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 0;
}
.dsh-cloud-sync-card__button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 5px 14px;
  background: none;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-cloud-sync-card__button:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-label-dimmed);
}
.dsh-cloud-sync-card__button:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-cloud-sync-card__button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-cloud-sync-card__button--primary {
  background: var(--dsw-alias-label-primary);
  border-color: transparent;
  color: var(--dsw-alias-bg-layer-3);
}
.dsh-cloud-sync-card__button--primary:hover:not(:disabled) {
  color: var(--dsw-alias-bg-layer-3);
  border-color: transparent;
}
.dsh-cloud-sync-card__status {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-card__status--muted {
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__status--error {
  color: var(--dsw-alias-label-error);
}
.dsh-cloud-sync-card__dot {
  position: relative;
  top: -1px;
  align-self: center;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-card__dot[data-state='done'] {
  background: var(--dsw-alias-state-success-primary);
}
.dsh-cloud-sync-card__dot[data-state='warning'] {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-cloud-sync-card__dot[data-state='error'] {
  background: var(--dsw-alias-state-error-primary);
}
.dsh-cloud-sync-card__warn {
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-cloud-sync-card__switch-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.dsh-cloud-sync-card__switch-label {
  width: 120px;
  flex: none;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-card__switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  border: none;
  border-radius: 999px;
  padding: 0;
  background: var(--dsw-alias-bg-module-platform);
  cursor: pointer;
  transition: background .16s;
}
.dsh-cloud-sync-card__switch[data-on='true'] {
  background: var(--dsw-alias-brand-primary);
}
.dsh-cloud-sync-card__switch:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-cloud-sync-card__switch:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-cloud-sync-card__switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-3);
  transition: transform .16s;
}
.dsh-cloud-sync-card__switch[data-on='true'] .dsh-cloud-sync-card__switch-knob {
  transform: translateX(16px);
}
.dsh-cloud-sync-card__sync-result {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
/* ---- M4：路径映射区 ---- */
.dsh-cloud-sync-card__mappings {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dsh-cloud-sync-card__mapping {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}
.dsh-cloud-sync-card__mapping-paths {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-card__mapping-arrow {
  margin: 0 6px;
  color: var(--dsw-alias-label-dimmed);
}
/* ---- M4：恢复对话框 ---- */
.dsh-cloud-sync-restore {
  width: 720px;
  max-width: calc(100vw - 64px);
}
.dsh-cloud-sync-restore__content {
  max-height: 60vh;
  overflow-y: auto;
}
.dsh-cloud-sync-restore__filter {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.dsh-cloud-sync-restore__select {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 4px 10px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-restore__head,
.dsh-cloud-sync-restore__row {
  display: grid;
  grid-template-columns: 24px minmax(0, 2fr) 88px 56px minmax(0, 2.2fr);
  align-items: center;
  gap: 10px;
}
.dsh-cloud-sync-restore__head {
  padding: 4px 0;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-cloud-sync-restore__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.dsh-cloud-sync-restore__row {
  padding: 8px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}
.dsh-cloud-sync-restore__row[data-disabled='true'] {
  opacity: 0.55;
}
.dsh-cloud-sync-restore__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-restore__device {
  margin-left: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-dimmed);
}
.dsh-cloud-sync-restore__updated,
.dsh-cloud-sync-restore__events {
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-restore__target {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.dsh-cloud-sync-restore__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-restore__badge {
  flex: none;
  margin-left: 6px;
  border-radius: 999px;
  padding: 0 6px;
  font-size: 10px;
  line-height: 16px;
  background: var(--dsw-alias-bg-module-platform);
  color: var(--dsw-alias-label-secondary);
}
.dsh-cloud-sync-restore__badge--muted {
  background: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-cloud-sync-restore__unmatched {
  flex: none;
  font-size: 12px;
  color: var(--dsw-alias-state-warn-primary);
}
.dsh-cloud-sync-restore__pick {
  flex: none;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 2px 8px;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-cloud-sync-restore__manual {
  flex: 1;
  min-width: 0;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-restore__selected {
  flex: 1;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
/* ---- M4：启动检查通知（01 §5.5 右下角轻提示；shell.overlay 层默认 click-through，需自行恢复指针事件） ---- */
.dsh-cloud-sync-notice {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: 0 8px 24px rgb(0 0 0 / 18%);
  pointer-events: auto;
}
.dsh-cloud-sync-notice__text {
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-cloud-sync-notice__action {
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-brand-primary);
  cursor: pointer;
}
.dsh-cloud-sync-notice__dismiss {
  appearance: none;
  border: none;
  background: none;
  padding: 2px 4px;
  font: inherit;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
`

/** 样式标签的幂等标记（重复挂载/重放时只注入一次）。 */
const STYLE_TAG_ID = 'dsh-cloud-sync/card'

/** 把卡片样式注入 document.head；非浏览器环境（node 单测）直接跳过。 */
export function installCardStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-cloud-sync'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CARD_CSS
  document.head.appendChild(tag)
}
