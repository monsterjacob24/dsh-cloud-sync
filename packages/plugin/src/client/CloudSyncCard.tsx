/**
 * 云端同步设置卡组件（M3 四区：服务器连接 / 状态行 / 同步方式 / 操作）。
 * 「从云端恢复会话」按钮与「路径映射」区属 M4，本卡片不实现。
 * 卡片 chrome 自绘（ui-settings-plugins 的 PluginCard/CardForm/fields 是该包内部实现，
 * 跨包值 import 会触发 client bundle-purity gate），样式见 styles.ts。
 * 全部可见文案经 props.t 查字典（locales.ts），本文件不出现自然语言字面量。
 */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// 类型 import（被擦除）：拉入 settings.plugin.item 槽的 SlotMap 合并
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { CloudSyncCardFace } from './cloud-sync-card-controller.ts'
import { errorKeyOf, type RelativeTimeSpec } from './pure.ts'

/** 渲染器组装后的组件 props：运行时份 + 字典 t 座位 + controller 注入份。 */
export type CloudSyncCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.cloudSync'>
  & InjectFace<CloudSyncCardFace>

/** 显示/隐藏密码的图标字形：符号而非自然语言，不进字典。 */
const EYE_GLYPH = '👁'
/** 删除映射的图标字形：同上，符号不进字典。 */
const TRASH_GLYPH = '🗑'

/** secret 已配置时的占位符（01 §4：写入后显示占位符，值本身永不回显）。 */
const SECRET_MASK = '••••••••••••'

/**
 * 告诉浏览器与密码管理器「这不是登录凭据」：Chrome 对 autocomplete="off"
 * 的 password 字段照样弹保存/更新提示，new-password 才是它认的信号；
 * data-* 分别压住 LastPass / 1Password / Bitwarden。
 */
const NOT_A_CREDENTIAL = {
  autoComplete: 'new-password',
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
} as const

/** 把相对时间规格翻译成文案（恢复对话框复用）。 */
export function relativeText(t: TranslateNS<'settings.cloudSync'>, spec: RelativeTimeSpec): string {
  return spec.key === 'time.justNow' ? t('time.justNow') : t(spec.key, { count: spec.count })
}

/**
 * 渲染云端同步设置卡。
 * @param props - 字典 t、卡片快照（useCloudSyncCard）与表单动作。
 * @returns 卡片；namespace 不可用时不渲染（Host 未 serve 即 UI 无痕迹）。
 */
export function CloudSyncCard(props: CloudSyncCardProps) {
  const { t } = props
  const state = props.useCloudSyncCard(snapshot => snapshot)
  // 显示/隐藏密码是纯阅读姿态，组件本地状态即可
  const [showToken, setShowToken] = useState(false)
  const [showPassphrase, setShowPassphrase] = useState(false)
  if (!state.available) return null
  const disabled = !state.writable
  const line = state.statusLine
  return (
    <li className="dsh-cloud-sync-card">
      <div className="dsh-cloud-sync-card__header">
        <span className="dsh-cloud-sync-card__name">{t('title')}</span>
        <span className="dsh-cloud-sync-card__description">{t('description')}</span>
      </div>
      <div className="dsh-cloud-sync-card__body">
        <section className="dsh-cloud-sync-card__section">
          <h3 className="dsh-cloud-sync-card__section-title">{t('section.connection')}</h3>
          <div className="dsh-cloud-sync-card__field">
            <div className="dsh-cloud-sync-card__field-head">
              <label className="dsh-cloud-sync-card__label" htmlFor="dsh-cloud-sync-server-url">
                {t('field.serverUrl')}
              </label>
            </div>
            <input
              id="dsh-cloud-sync-server-url"
              className="dsh-cloud-sync-card__input"
              type="text"
              value={state.serverUrlDraft}
              placeholder={t('field.serverUrl.placeholder')}
              disabled={disabled}
              {...state.serverUrlInvalid ? { 'aria-invalid': true } : {}}
              onChange={(event) => { props.editServerUrl(event.target.value) }}
              onBlur={() => { props.commitServerUrl() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.commitServerUrl()
              }}
            />
            {state.serverUrlInvalid
              ? <p className="dsh-cloud-sync-card__error">{t('invalid.serverUrl')}</p>
              : null}
          </div>
          <div className="dsh-cloud-sync-card__field">
            <div className="dsh-cloud-sync-card__field-head">
              <label className="dsh-cloud-sync-card__label" htmlFor="dsh-cloud-sync-username">
                {t('field.username')}
              </label>
            </div>
            <input
              id="dsh-cloud-sync-username"
              className="dsh-cloud-sync-card__input"
              type="text"
              autoComplete="off"
              value={state.usernameDraft}
              placeholder={state.usernameDraft === '' ? t('field.username.hint') : undefined}
              disabled={disabled}
              onChange={(event) => { props.editUsername(event.target.value) }}
              onBlur={() => { props.commitUsername() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.commitUsername()
              }}
            />
          </div>
          <div className="dsh-cloud-sync-card__field">
            <div className="dsh-cloud-sync-card__field-head">
              <label className="dsh-cloud-sync-card__label" htmlFor="dsh-cloud-sync-token">
                {t('field.token')}
              </label>
              <span
                className={state.tokenConfigured
                  ? 'dsh-cloud-sync-card__badge'
                  : 'dsh-cloud-sync-card__badge dsh-cloud-sync-card__badge--muted'}
              >
                {t(state.tokenConfigured ? 'field.configured' : 'field.unconfigured')}
              </span>
            </div>
            <div className="dsh-cloud-sync-card__input-row">
              <input
                id="dsh-cloud-sync-token"
                className="dsh-cloud-sync-card__input"
                type={showToken ? 'text' : 'password'}
                {...NOT_A_CREDENTIAL}
                placeholder={state.tokenConfigured ? SECRET_MASK : undefined}
                value={state.tokenDraft}
                disabled={disabled}
                onChange={(event) => { props.editToken(event.target.value) }}
                onBlur={() => { props.commitToken() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') props.commitToken()
                }}
              />
              <button
                type="button"
                className="dsh-cloud-sync-card__icon-button"
                aria-label={t(showToken ? 'field.secret.hide' : 'field.secret.show')}
                disabled={disabled}
                onClick={() => { setShowToken(!showToken) }}
              >
                {EYE_GLYPH}
              </button>
            </div>
          </div>
          <div className="dsh-cloud-sync-card__field">
            <div className="dsh-cloud-sync-card__field-head">
              <label className="dsh-cloud-sync-card__label" htmlFor="dsh-cloud-sync-passphrase">
                {t('field.passphrase')}
              </label>
              <span
                className={state.passphraseConfigured
                  ? 'dsh-cloud-sync-card__badge'
                  : 'dsh-cloud-sync-card__badge dsh-cloud-sync-card__badge--muted'}
              >
                {t(state.passphraseConfigured ? 'field.configured' : 'field.unconfigured')}
              </span>
            </div>
            <div className="dsh-cloud-sync-card__input-row">
              <input
                id="dsh-cloud-sync-passphrase"
                className="dsh-cloud-sync-card__input"
                type={showPassphrase ? 'text' : 'password'}
                {...NOT_A_CREDENTIAL}
                placeholder={state.passphraseConfigured ? SECRET_MASK : undefined}
                value={state.passphraseDraft}
                disabled={disabled}
                onChange={(event) => { props.editPassphrase(event.target.value) }}
                onBlur={() => { props.commitPassphrase() }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') props.commitPassphrase()
                }}
              />
              <button
                type="button"
                className="dsh-cloud-sync-card__icon-button"
                aria-label={t(showPassphrase ? 'field.secret.hide' : 'field.secret.show')}
                disabled={disabled}
                onClick={() => { setShowPassphrase(!showPassphrase) }}
              >
                {EYE_GLYPH}
              </button>
            </div>
          </div>
          <div className="dsh-cloud-sync-card__field">
            <div className="dsh-cloud-sync-card__field-head">
              <label className="dsh-cloud-sync-card__label" htmlFor="dsh-cloud-sync-device-name">
                {t('field.deviceName')}
              </label>
            </div>
            <input
              id="dsh-cloud-sync-device-name"
              className="dsh-cloud-sync-card__input"
              type="text"
              value={state.deviceNameDraft}
              disabled={disabled}
              {...state.deviceNameInvalid ? { 'aria-invalid': true } : {}}
              onChange={(event) => { props.editDeviceName(event.target.value) }}
              onBlur={() => { props.commitDeviceName() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') props.commitDeviceName()
              }}
            />
            <p className={state.deviceNameInvalid
              ? 'dsh-cloud-sync-card__error'
              : 'dsh-cloud-sync-card__hint'}
            >
              {t(state.deviceNameInvalid ? 'invalid.deviceName' : 'field.deviceName.hint')}
            </p>
          </div>
          <div className="dsh-cloud-sync-card__row-end">
            <button
              type="button"
              className="dsh-cloud-sync-card__button"
              disabled={disabled || state.testPending || !state.canTest}
              onClick={() => { props.testConnection() }}
            >
              {t(state.testPending ? 'action.testing' : 'action.testConnection')}
            </button>
          </div>
        </section>
        <section className="dsh-cloud-sync-card__section">
          {line.kind === 'unconfigured'
            ? (
              <p className="dsh-cloud-sync-card__status dsh-cloud-sync-card__status--muted">
                <span className="dsh-cloud-sync-card__dot" />
                {t('status.unconfigured')}
              </p>
            )
            : null}
          {line.kind === 'failed'
            ? (
              <p
                className="dsh-cloud-sync-card__status dsh-cloud-sync-card__status--error"
                title={line.detail === '' ? undefined : line.detail}
              >
                <span className="dsh-cloud-sync-card__dot" data-state="error" />
                {t('status.disconnected', { reason: t(errorKeyOf(line.error)) })}
              </p>
            )
            : null}
          {line.kind === 'connected'
            ? (
              <p
                className="dsh-cloud-sync-card__status"
                title={line.warn
                  ? (line.error === 'deviceConflict'
                    ? t('error.deviceConflict')
                    : line.detail === '' ? undefined : line.detail)
                  : undefined}
              >
                <span className="dsh-cloud-sync-card__dot" data-state={line.warn ? 'warning' : 'done'} />
                {line.warn ? <span className="dsh-cloud-sync-card__warn">{t('status.warnMark')}</span> : null}
                {t('status.connected', { count: line.count })}
                {line.lastSync !== null
                  ? ` · ${t('status.lastSync', { time: relativeText(t, line.lastSync) })}`
                  : null}
              </p>
            )
            : null}
        </section>
        <section className="dsh-cloud-sync-card__section">
          <h3 className="dsh-cloud-sync-card__section-title">{t('section.sync')}</h3>
          <div className="dsh-cloud-sync-card__switch-row">
            <span className="dsh-cloud-sync-card__switch-label" id="dsh-cloud-sync-auto-upload-label">
              {t('field.autoUpload')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={state.autoUpload}
              aria-labelledby="dsh-cloud-sync-auto-upload-label"
              className="dsh-cloud-sync-card__switch"
              data-on={state.autoUpload}
              disabled={disabled}
              onClick={() => { props.toggleAutoUpload() }}
            >
              <span className="dsh-cloud-sync-card__switch-knob" />
            </button>
            <span className="dsh-cloud-sync-card__hint">{t('field.autoUpload.hint')}</span>
          </div>
          <div className="dsh-cloud-sync-card__switch-row">
            <span className="dsh-cloud-sync-card__switch-label" id="dsh-cloud-sync-check-on-startup-label">
              {t('field.checkOnStartup')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={state.checkOnStartup}
              aria-labelledby="dsh-cloud-sync-check-on-startup-label"
              className="dsh-cloud-sync-card__switch"
              data-on={state.checkOnStartup}
              disabled={disabled}
              onClick={() => { props.toggleCheckOnStartup() }}
            >
              <span className="dsh-cloud-sync-card__switch-knob" />
            </button>
            <span className="dsh-cloud-sync-card__hint">{t('field.checkOnStartup.hint')}</span>
          </div>
        </section>
        <section className="dsh-cloud-sync-card__section">
          <h3 className="dsh-cloud-sync-card__section-title">{t('section.actions')}</h3>
          {state.syncResult !== null
            ? (
              <p className="dsh-cloud-sync-card__sync-result" role="status">
                {t('sync.result', { ok: state.syncResult.ok, failed: state.syncResult.failed })}
                {state.syncResult.failed > 0 && state.syncResult.error !== ''
                  ? ` — ${state.syncResult.error}`
                  : null}
              </p>
            )
            : null}
          <div className="dsh-cloud-sync-card__row-end">
            <button
              type="button"
              className="dsh-cloud-sync-card__button"
              disabled={disabled || state.catalogPending}
              onClick={() => { props.openRestore() }}
            >
              {t('action.restore')}
            </button>
            <button
              type="button"
              className="dsh-cloud-sync-card__button dsh-cloud-sync-card__button--primary"
              disabled={disabled || state.syncPending || !state.canSync}
              onClick={() => { props.syncAll() }}
            >
              {t(state.syncPending ? 'action.syncing' : 'action.syncAll')}
            </button>
          </div>
        </section>
        <section className="dsh-cloud-sync-card__section">
          <h3 className="dsh-cloud-sync-card__section-title">{t('section.mappings')}</h3>
          {state.mappings.length === 0
            ? <p className="dsh-cloud-sync-card__hint">{t('mapping.empty')}</p>
            : (
              <ul className="dsh-cloud-sync-card__mappings">
                {state.mappings.map((pair) => (
                  <li key={pair.from} className="dsh-cloud-sync-card__mapping">
                    <span className="dsh-cloud-sync-card__mapping-paths" title={`${pair.from} → ${pair.to}`}>
                      {pair.from}
                      <span className="dsh-cloud-sync-card__mapping-arrow">→</span>
                      {pair.to}
                    </span>
                    <button
                      type="button"
                      className="dsh-cloud-sync-card__icon-button"
                      aria-label={t('mapping.delete')}
                      disabled={disabled}
                      onClick={() => { props.deleteMapping(pair.from) }}
                    >
                      {TRASH_GLYPH}
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </li>
  )
}
