// Bilingual JSON responses.
//
// El backend NO sabe el idioma del cliente al responder (el JWT no lleva
// `lang` y leer la BD en cada error sería ridículo). En lugar de
// negociar localización en server, devolvemos:
//
//   - `code`: identificador estable del mensaje (e.g. AUTH_INVALID_CREDENTIALS)
//   - `error` o `message`: fallback en inglés
//   - `args` (opcional): valores para interpolar en placeholders {min}, {max}, etc.
//
// El frontend tiene un catálogo `i18n.js` que mapea cada `code` a su
// traducción en el idioma activo del usuario, e interpola `args`. Si el
// `code` no existe en el catálogo (versión vieja del cliente, etc.), el
// frontend muestra el `error` literal en inglés. Mejor inglés que pantalla
// rota.

export type ErrorCode = string;
export type MessageCode = string;

export interface ErrorPayload {
  code: ErrorCode;
  error: string;
  args?: Record<string, string | number>;
}

export interface OkPayload {
  code: MessageCode;
  message: string;
  args?: Record<string, string | number>;
  [extra: string]: unknown;
}

export function errResp(
  code: ErrorCode,
  fallback: string,
  args?: Record<string, string | number>,
): ErrorPayload {
  return args ? { code, error: fallback, args } : { code, error: fallback };
}

export function okResp(
  code: MessageCode,
  fallback: string,
  extra?: Record<string, unknown>,
): OkPayload {
  return { code, message: fallback, ...(extra || {}) };
}

// ───────── Catálogo de códigos (single source of truth) ─────────
// Todos los códigos que el backend puede emitir. Mantener sincronizado
// con `i18n.js` del frontend. Si añades un código aquí y NO lo añades al
// catálogo del frontend, el cliente cae al fallback inglés (no rompe).

export const RC = {
  // Genéricos
  SERVER_ERROR: 'common.server_error',
  NOT_FOUND: 'common.not_found',
  USER_NOT_FOUND: 'common.user_not_found',

  // Auth: validación de inputs
  AUTH_EMAIL_PASSWORD_NAME_REQUIRED: 'auth.email_password_name_required',
  AUTH_EMAIL_PASSWORD_REQUIRED: 'auth.email_password_required',
  AUTH_EMAIL_INVALID: 'auth.email_invalid',
  AUTH_EMAIL_TOO_LONG: 'auth.email_too_long',
  AUTH_EMAIL_IN_USE: 'auth.email_in_use',
  AUTH_NAME_INVALID: 'auth.name_invalid',
  AUTH_PASSWORD_REQUIRED: 'auth.password_required',
  AUTH_PASSWORD_TOO_SHORT: 'auth.password_too_short',
  AUTH_PASSWORD_TOO_LONG: 'auth.password_too_long',
  AUTH_PASSWORD_NEEDS_UPPER: 'auth.password_needs_upper',
  AUTH_PASSWORD_NEEDS_LOWER: 'auth.password_needs_lower',
  AUTH_PASSWORD_NEEDS_DIGIT: 'auth.password_needs_digit',
  AUTH_PASSWORD_NEEDS_UPPER_DIGIT: 'auth.password_needs_upper_digit',
  AUTH_PASSWORD_SAME_AS_CURRENT: 'auth.password_same_as_current',
  AUTH_PASSWORDS_REQUIRED: 'auth.passwords_required',
  AUTH_CURRENT_PASSWORD_WRONG: 'auth.current_password_wrong',

  // Auth: credenciales/sesión
  AUTH_INVALID_CREDENTIALS: 'auth.invalid_credentials',
  AUTH_TOKEN_REQUIRED: 'auth.token_required',
  AUTH_TOKEN_INVALID: 'auth.token_invalid',
  AUTH_TOKEN_PENDING: 'auth.token_pending',
  AUTH_SESSION_EXPIRED: 'auth.session_expired',
  AUTH_SESSION_VALIDATION_ERROR: 'auth.session_validation_error',
  AUTH_LOGIN_PENDING_REQUIRED: 'auth.login_pending_required',
  AUTH_LOGIN_PENDING_INVALID: 'auth.login_pending_invalid',
  AUTH_LOGIN_PENDING_EXPIRED: 'auth.login_pending_expired',
  AUTH_NO_PENDING_CODE: 'auth.no_pending_code',

  // Auth: códigos / MFA / reset
  AUTH_CODE_INVALID_FORMAT: 'auth.code_invalid_format',
  AUTH_CODE_INCORRECT: 'auth.code_incorrect',
  AUTH_CODE_EXPIRED: 'auth.code_expired',
  AUTH_CODE_TOO_MANY_ATTEMPTS: 'auth.code_too_many_attempts',
  AUTH_CODE_RESEND_COOLDOWN: 'auth.code_resend_cooldown',
  AUTH_CODE_SEND_FAIL: 'auth.code_send_fail',
  AUTH_RESET_LINK_INVALID: 'auth.reset_link_invalid',
  AUTH_RESET_LINK_EXPIRED: 'auth.reset_link_expired',
  AUTH_RESET_EMAIL_FAIL: 'auth.reset_email_fail',
  AUTH_NO_PENDING_EMAIL_CHANGE: 'auth.no_pending_email_change',
  AUTH_EMAIL_TAKEN_DURING_CHANGE: 'auth.email_taken_during_change',

  // Auth: rate limits
  RL_LOGIN: 'rate.login',
  RL_SIGNUP: 'rate.signup',
  RL_FORGOT: 'rate.forgot',
  RL_CODE: 'rate.code',

  // Auth: ok
  AUTH_SIGNUP_OK: 'auth.signup_ok',
  AUTH_LOGIN_OK: 'auth.login_ok',
  AUTH_LOGIN_COMPLETE: 'auth.login_complete',
  AUTH_PROFILE_UPDATED: 'auth.profile_updated',
  AUTH_EMAIL_CHANGE_REQUESTED: 'auth.email_change_requested',
  AUTH_EMAIL_UPDATED: 'auth.email_updated',
  AUTH_PASSWORD_RESET_OK: 'auth.password_reset_ok',
  AUTH_PASSWORD_UPDATED: 'auth.password_updated',
  AUTH_FORGOT_OK: 'auth.forgot_ok',
  AUTH_CODE_SENT: 'auth.code_sent',
  AUTH_LANG_UPDATED: 'auth.lang_updated',
  AUTH_NOTHING_TO_UPDATE: 'auth.nothing_to_update',

  // Bots
  BOT_NOT_FOUND: 'bot.not_found',
  BOT_LIST_FAIL: 'bot.list_fail',
  BOT_GET_FAIL: 'bot.get_fail',
  BOT_UPDATE_FAIL: 'bot.update_fail',
  BOT_UPDATED: 'bot.updated',
  BOT_DELETE_FAIL: 'bot.delete_fail',
  BOT_DELETED: 'bot.deleted',
  BOT_DOWNLOAD_FAIL: 'bot.download_fail',
  BOT_CREATE_DEPRECATED: 'bot.create_deprecated',

  // Pagos
  PAY_GATEWAY_DOWN: 'pay.gateway_down',
  PAY_CHECKOUT_FAIL: 'pay.checkout_fail',
  PAY_CONFIG_REQUIRED: 'pay.config_required',
  PAY_NAME_INVALID: 'pay.name_invalid',
  PAY_STRATEGY_INVALID: 'pay.strategy_invalid',
  PAY_ORDER_NOT_FOUND: 'pay.order_not_found',
  PAY_NOT_CONFIRMED: 'pay.not_confirmed',
  PAY_FOREIGN_ORDER: 'pay.foreign_order',
  PAY_ALREADY_VERIFIED: 'pay.already_verified',
  PAY_VERIFIED: 'pay.verified',
  PAY_VERIFY_FAIL: 'pay.verify_fail',
  PAY_RECOVER_OK: 'pay.recover_ok',
  PAY_RECOVER_FAIL: 'pay.recover_fail',

  // Brokers
  BROKER_FIELDS_REQUIRED: 'broker.fields_required',
  BROKER_DUPLICATE: 'broker.duplicate',
  BROKER_CONNECT_OK: 'broker.connect_ok',
  BROKER_CONNECT_FAIL: 'broker.connect_fail',
  BROKER_LIST_FAIL: 'broker.list_fail',
  BROKER_NOT_FOUND: 'broker.not_found',
  BROKER_DISCONNECT_OK: 'broker.disconnect_ok',
  BROKER_DISCONNECT_FAIL: 'broker.disconnect_fail',

  // Marketplace
  MP_TEMPLATES_FAIL: 'mp.templates_fail',
  MP_TEMPLATE_NOT_FOUND: 'mp.template_not_found',
  MP_TEMPLATE_GET_FAIL: 'mp.template_get_fail',
  MP_TEMPLATE_REQUIRED: 'mp.template_required',
  MP_BOT_PURCHASED: 'mp.bot_purchased',
  MP_BOT_PURCHASE_FAIL: 'mp.bot_purchase_fail',
} as const;

export type RC_Code = typeof RC[keyof typeof RC];
