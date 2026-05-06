import { Resend } from 'resend';

let cached: Resend | null = null;
function getClient(): Resend {
  if (cached) return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY no configurada');
  cached = new Resend(key);
  return cached;
}

const FROM = process.env.EMAIL_FROM || 'Yudbot <onboarding@resend.dev>';
// URL pública del logo para emails. Gmail no renderiza inline SVG, así que
// debemos hospedar el PNG. Por defecto en el dominio del frontend.
const LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://algotrade-beige.vercel.app/logo-black.png';

export type Lang = 'es' | 'en';

// Normaliza el lang: cualquier valor que no sea 'en' cae a 'es' (default).
function L(lang?: string | null): Lang {
  return lang === 'en' ? 'en' : 'es';
}

// ───────── Plantilla base reutilizable ─────────
function baseTemplate(opts: {
  preheader: string;
  title: string;
  intro: string;
  block?: string;
  outro?: string;
  footer?: string;
  lang: Lang;
}): string {
  const footer = opts.footer || (opts.lang === 'en'
    ? 'Yudbot · Bot generator for MetaTrader 4 and 5<br/>Do not reply to this email. Support: <a href="mailto:support@yudbot.com" style="color:#000;text-decoration:underline">support@yudbot.com</a>'
    : 'Yudbot · Generador de bots para MetaTrader 4 y 5<br/>No respondas a este correo. Para soporte: <a href="mailto:support@yudbot.com" style="color:#000;text-decoration:underline">support@yudbot.com</a>');
  return `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${opts.title}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#1a1a1a">
  <span style="display:none;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${opts.preheader}</span>
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="background:#ffffff;border-radius:16px;padding:40px 32px;border:1px solid #e5e5e5;box-shadow:0 1px 3px rgba(0,0,0,0.04)">
      <img src="${LOGO_URL}" alt="YudBot" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:12px;margin-bottom:24px;border:0;outline:none;text-decoration:none"/>
      <h1 style="font-size:24px;font-weight:800;letter-spacing:-0.02em;margin:0 0 12px;color:#000;line-height:1.2">${opts.title}</h1>
      <p style="font-size:15px;line-height:1.55;color:#555;margin:0 0 24px">${opts.intro}</p>
      ${opts.block || ''}
      ${opts.outro ? `<p style="font-size:14px;line-height:1.55;color:#666;margin:24px 0 0">${opts.outro}</p>` : ''}
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12px;color:#888;line-height:1.6">
      ${footer}
    </div>
  </div>
</body>
</html>`;
}

// ───────── EMAIL: BIENVENIDA TRAS SIGNUP ─────────
export async function sendWelcomeEmail(to: string, name: string, lang?: Lang): Promise<void> {
  const client = getClient();
  const L_ = L(lang);
  const greeting = name ? name.split(' ')[0] : (L_ === 'en' ? 'trader' : 'trader');
  const appUrl = L_ === 'en' ? 'https://yudbot.com/en/app' : 'https://yudbot.com/app';

  const COPY = L_ === 'en' ? {
    subject: `Welcome to Yudbot, ${greeting}! 🤖`,
    preheader: 'Welcome to Yudbot! Your account is active.',
    title: `Welcome to Yudbot, ${greeting}!`,
    intro: 'Your account is active. You just took the first step toward creating custom trading bots without writing code.',
    nextSteps: 'Next steps',
    step1: 'Create your first bot with the guided 8-step wizard.',
    step2: 'Pick market, strategy, indicators and risk rules.',
    step3: 'Download the .mq5 / .mq4 file and drop it into MetaTrader.',
    cta: 'Create my first bot →',
    outro: 'For security, every time you log in we send a 6-digit code to this email.',
    textBody: `Welcome to Yudbot, ${greeting}!

Your account is active.

Next steps:
1. Create your first bot with the guided wizard.
2. Pick market, strategy, indicators and risk rules.
3. Download the .mq5 or .mq4 and drop it into MetaTrader.

Get started: ${appUrl}

For security, every time you log in we send a 6-digit code to this email.

— The Yudbot team`,
  } : {
    subject: `¡Bienvenido a Yudbot, ${greeting}! 🤖`,
    preheader: '¡Bienvenido a Yudbot! Tu cuenta ya está activa.',
    title: `¡Bienvenido a Yudbot, ${greeting}!`,
    intro: 'Tu cuenta ya está activa. Has dado el primer paso para crear bots de trading personalizados sin escribir código.',
    nextSteps: 'Próximos pasos',
    step1: 'Crea tu primer bot con el wizard guiado de 8 pasos.',
    step2: 'Elige mercado, estrategia, indicadores y reglas de riesgo.',
    step3: 'Descarga el archivo .mq5 / .mq4 y arrástralo a MetaTrader.',
    cta: 'Crear mi primer bot →',
    outro: 'Por seguridad, cada vez que inicies sesión te enviaremos un código de 6 dígitos a este email.',
    textBody: `¡Bienvenido a Yudbot, ${greeting}!

Tu cuenta ya está activa.

Próximos pasos:
1. Crea tu primer bot con el wizard guiado.
2. Elige mercado, estrategia, indicadores y reglas de riesgo.
3. Descarga el .mq5 o .mq4 y arrástralo a MetaTrader.

Empieza aquí: ${appUrl}

Por seguridad, cada vez que inicies sesión te enviaremos un código de 6 dígitos a este email.

— El equipo de Yudbot`,
  };

  const html = baseTemplate({
    lang: L_,
    preheader: COPY.preheader,
    title: COPY.title,
    intro: COPY.intro,
    block: `
      <div style="background:#fafafa;border-radius:12px;padding:20px;margin:0 0 16px;border:1px solid #eee">
        <div style="font-size:13px;font-weight:700;color:#000;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">${COPY.nextSteps}</div>
        <ol style="margin:0;padding-left:20px;color:#444;line-height:1.7;font-size:14px">
          <li>${COPY.step1}</li>
          <li>${COPY.step2}</li>
          <li>${COPY.step3}</li>
        </ol>
      </div>
      <a href="${appUrl}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px;margin-top:8px">${COPY.cta}</a>
    `,
    outro: COPY.outro,
  });

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: COPY.subject,
    text: COPY.textBody,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

// ───────── EMAIL: CÓDIGO DE LOGIN (MFA) ─────────
export async function sendLoginCodeEmail(to: string, name: string, code: string, lang?: Lang): Promise<void> {
  const client = getClient();
  const L_ = L(lang);

  const COPY = L_ === 'en' ? {
    subject: `Yudbot: your login code ${code}`,
    preheader: `Your Yudbot login code: ${code}`,
    title: 'Your login code',
    intro: `Hi ${name || ''},<br/>To log in to your Yudbot account, enter this code:`,
    expires: 'Expires in 10 minutes.',
    notYou: 'If you are not trying to log in, ignore this email and consider changing your password.',
    text: `Hi ${name || ''},

Your Yudbot login code is:

  ${code}

Expires in 10 minutes. If you are not trying to log in, ignore this email.

— Yudbot`,
  } : {
    subject: `Yudbot: tu código de acceso ${code}`,
    preheader: `Tu código de acceso a Yudbot: ${code}`,
    title: 'Tu código de acceso',
    intro: `Hola ${name || ''},<br/>Para entrar a tu cuenta de Yudbot, introduce este código:`,
    expires: 'Caduca en 10 minutos.',
    notYou: 'Si no estás intentando acceder a tu cuenta, ignora este correo y considera cambiar tu contraseña.',
    text: `Hola ${name || ''},

Tu código de acceso a Yudbot es:

  ${code}

Caduca en 10 minutos. Si no estás intentando acceder a tu cuenta, ignora este correo.

— Yudbot`,
  };

  const html = baseTemplate({
    lang: L_,
    preheader: COPY.preheader,
    title: COPY.title,
    intro: COPY.intro,
    block: `
      <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:0 0 20px">
        <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#000">${code}</div>
      </div>
      <p style="font-size:13px;color:#888;margin:0 0 4px">${COPY.expires}</p>
      <p style="font-size:13px;color:#888;margin:0">${COPY.notYou}</p>
    `,
  });

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: COPY.subject,
    text: COPY.text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

// ───────── EMAIL: RESET DE CONTRASEÑA ─────────
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string, lang?: Lang): Promise<void> {
  const client = getClient();
  const L_ = L(lang);

  const COPY = L_ === 'en' ? {
    subject: 'Reset your YudBot password',
    preheader: 'Reset your YudBot password',
    title: 'Reset your password',
    intro: `Hi ${name || ''},<br/>We received a request to reset your YudBot password. Click the button to set a new one:`,
    cta: 'Reset password →',
    expiresOnce: 'The link expires in 1 hour and can only be used once.',
    fallback: 'If the button does not work, copy and paste this link into your browser:',
    warning: '⚠️ If you did not request this reset, ignore this email. Your current password will remain valid.',
    text: `Hi ${name || ''},

You requested a password reset for your YudBot account.

Open this link to set a new password (expires in 1 hour):

${resetUrl}

If you did not request this change, ignore this email. Your current password will remain valid.

— YudBot`,
  } : {
    subject: 'Restablece tu contraseña de YudBot',
    preheader: 'Restablece tu contraseña de YudBot',
    title: 'Restablece tu contraseña',
    intro: `Hola ${name || ''},<br/>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de YudBot. Haz click en el botón para crear una nueva:`,
    cta: 'Restablecer contraseña →',
    expiresOnce: 'El enlace caduca en 1 hora y solo se puede usar una vez.',
    fallback: 'Si el botón no funciona, copia y pega este enlace en tu navegador:',
    warning: '⚠️ Si no has solicitado este restablecimiento, ignora este correo. Tu contraseña actual seguirá siendo válida.',
    text: `Hola ${name || ''},

Has solicitado restablecer la contraseña de tu cuenta de YudBot.

Abre este enlace para crear una nueva contraseña (caduca en 1 hora):

${resetUrl}

Si no has pedido este cambio, ignora este correo. Tu contraseña actual seguirá siendo válida.

— YudBot`,
  };

  const html = baseTemplate({
    lang: L_,
    preheader: COPY.preheader,
    title: COPY.title,
    intro: COPY.intro,
    block: `
      <div style="text-align:center;margin:24px 0">
        <a href="${resetUrl}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:14px;letter-spacing:0.2px">${COPY.cta}</a>
      </div>
      <p style="font-size:13px;color:#666;line-height:1.55;margin:16px 0 0">${COPY.expiresOnce}</p>
      <p style="font-size:13px;color:#666;line-height:1.55;margin:8px 0 0">${COPY.fallback}</p>
      <p style="font-size:12px;color:#888;word-break:break-all;background:#f5f5f5;padding:10px 12px;border-radius:8px;margin:8px 0 0;font-family:'SF Mono','Menlo','Consolas',monospace">${resetUrl}</p>
      <div style="background:#fff8e6;border:1px solid #f5d97a;border-radius:10px;padding:14px 16px;font-size:13px;color:#7a5a00;line-height:1.5;margin-top:18px">
        ${COPY.warning}
      </div>
    `,
  });

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: COPY.subject,
    text: COPY.text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

export function generateResetToken(): string {
  // 32 bytes aleatorios = 64 chars hex, URL-safe, espacio ~10^77 (intratable por fuerza bruta)
  const bytes = require('crypto').randomBytes(32);
  return bytes.toString('hex');
}

// ───────── EMAIL: CONFIRMAR CAMBIO DE EMAIL ─────────
export async function sendEmailChangeCode(to: string, name: string, code: string, currentEmail: string, lang?: Lang): Promise<void> {
  const client = getClient();
  const L_ = L(lang);

  const COPY = L_ === 'en' ? {
    subject: `Yudbot: confirm your new email ${code}`,
    preheader: `Confirm your new Yudbot email: code ${code}`,
    title: 'Confirm your new email',
    intro: `Hi ${name || ''},<br/>You requested to change the email of your Yudbot account to <strong style="color:#000">${to}</strong>. To confirm, enter this code:`,
    warning: `⚠️ If you did not request this change, ignore this email. Your current email <strong>${currentEmail}</strong> stays active and nobody else has access to your account.`,
    expires: 'The code expires in 15 minutes.',
    text: `Hi ${name || ''},

You requested to change the email of your Yudbot account to ${to}.

Your confirmation code is:

  ${code}

Expires in 15 minutes.

If you did not request this change, ignore this email. Your current email (${currentEmail}) stays active.

— Yudbot`,
  } : {
    subject: `Yudbot: confirma tu nuevo email ${code}`,
    preheader: `Confirma tu nuevo email en Yudbot: código ${code}`,
    title: 'Confirma tu nuevo email',
    intro: `Hola ${name || ''},<br/>Has solicitado cambiar el email de tu cuenta de Yudbot a <strong style="color:#000">${to}</strong>. Para confirmarlo, introduce este código:`,
    warning: `⚠️ Si no has pedido este cambio, ignora este correo. Tu email actual <strong>${currentEmail}</strong> seguirá activo y nadie tendrá acceso a tu cuenta.`,
    expires: 'El código caduca en 15 minutos.',
    text: `Hola ${name || ''},

Has solicitado cambiar el email de tu cuenta de Yudbot a ${to}.

Tu código de confirmación es:

  ${code}

Caduca en 15 minutos.

Si no has pedido este cambio, ignora este correo. Tu email actual (${currentEmail}) seguirá activo.

— Yudbot`,
  };

  const html = baseTemplate({
    lang: L_,
    preheader: COPY.preheader,
    title: COPY.title,
    intro: COPY.intro,
    block: `
      <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:0 0 20px">
        <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#000">${code}</div>
      </div>
      <div style="background:#fff8e6;border:1px solid #f5d97a;border-radius:10px;padding:14px 16px;font-size:13px;color:#7a5a00;line-height:1.5">
        ${COPY.warning}
      </div>
      <p style="font-size:13px;color:#888;margin:14px 0 0">${COPY.expires}</p>
    `,
  });

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: COPY.subject,
    text: COPY.text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

export function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
