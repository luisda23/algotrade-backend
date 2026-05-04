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

// ───────── Plantilla base reutilizable ─────────
function baseTemplate(opts: {
  preheader: string;
  title: string;
  intro: string;
  block?: string;
  outro?: string;
  footer?: string;
}): string {
  return `<!DOCTYPE html>
<html>
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
      ${opts.footer || 'Yudbot · Generador de bots para MetaTrader 4 y 5<br/>No respondas a este correo. Para soporte: <a href="mailto:support@yudbot.com" style="color:#000;text-decoration:underline">support@yudbot.com</a>'}
    </div>
  </div>
</body>
</html>`;
}

// ───────── EMAIL: BIENVENIDA TRAS SIGNUP ─────────
export async function sendWelcomeEmail(to: string, name: string): Promise<void> {
  const client = getClient();
  const greeting = name ? name.split(' ')[0] : 'trader';

  const html = baseTemplate({
    preheader: '¡Bienvenido a Yudbot! Tu cuenta ya está activa.',
    title: `¡Bienvenido a Yudbot, ${greeting}!`,
    intro: 'Tu cuenta ya está activa. Has dado el primer paso para crear bots de trading personalizados sin escribir código.',
    block: `
      <div style="background:#fafafa;border-radius:12px;padding:20px;margin:0 0 16px;border:1px solid #eee">
        <div style="font-size:13px;font-weight:700;color:#000;margin-bottom:10px;text-transform:uppercase;letter-spacing:0.5px">Próximos pasos</div>
        <ol style="margin:0;padding-left:20px;color:#444;line-height:1.7;font-size:14px">
          <li>Crea tu primer bot con el wizard guiado de 8 pasos.</li>
          <li>Elige mercado, estrategia, indicadores y reglas de riesgo.</li>
          <li>Descarga el archivo .mq5 / .mq4 y arrástralo a MetaTrader.</li>
        </ol>
      </div>
      <a href="https://yudbot.com/app" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px;margin-top:8px">Crear mi primer bot →</a>
    `,
    outro: 'Por seguridad, cada vez que inicies sesión te enviaremos un código de 6 dígitos a este email.',
  });

  const text = `¡Bienvenido a Yudbot, ${greeting}!

Tu cuenta ya está activa.

Próximos pasos:
1. Crea tu primer bot con el wizard guiado.
2. Elige mercado, estrategia, indicadores y reglas de riesgo.
3. Descarga el .mq5 o .mq4 y arrástralo a MetaTrader.

Empieza aquí: https://yudbot.com/app

Por seguridad, cada vez que inicies sesión te enviaremos un código de 6 dígitos a este email.

— El equipo de Yudbot`;

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: `¡Bienvenido a Yudbot, ${greeting}! 🤖`,
    text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

// ───────── EMAIL: CÓDIGO DE LOGIN (MFA) ─────────
export async function sendLoginCodeEmail(to: string, name: string, code: string): Promise<void> {
  const client = getClient();

  const html = baseTemplate({
    preheader: `Tu código de acceso a Yudbot: ${code}`,
    title: 'Tu código de acceso',
    intro: `Hola ${name || ''},<br/>Para entrar a tu cuenta de Yudbot, introduce este código:`,
    block: `
      <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:0 0 20px">
        <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#000">${code}</div>
      </div>
      <p style="font-size:13px;color:#888;margin:0 0 4px">Caduca en 10 minutos.</p>
      <p style="font-size:13px;color:#888;margin:0">Si no estás intentando acceder a tu cuenta, ignora este correo y considera cambiar tu contraseña.</p>
    `,
  });

  const text = `Hola ${name || ''},

Tu código de acceso a Yudbot es:

  ${code}

Caduca en 10 minutos. Si no estás intentando acceder a tu cuenta, ignora este correo.

— Yudbot`;

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: `Yudbot: tu código de acceso ${code}`,
    text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

// ───────── EMAIL: RESET DE CONTRASEÑA ─────────
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string): Promise<void> {
  const client = getClient();

  const html = baseTemplate({
    preheader: 'Restablece tu contraseña de YudBot',
    title: 'Restablece tu contraseña',
    intro: `Hola ${name || ''},<br/>Hemos recibido una solicitud para restablecer la contraseña de tu cuenta de YudBot. Haz click en el botón para crear una nueva:`,
    block: `
      <div style="text-align:center;margin:24px 0">
        <a href="${resetUrl}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:600;font-size:14px;letter-spacing:0.2px">Restablecer contraseña →</a>
      </div>
      <p style="font-size:13px;color:#666;line-height:1.55;margin:16px 0 0">El enlace caduca en 1 hora y solo se puede usar una vez.</p>
      <p style="font-size:13px;color:#666;line-height:1.55;margin:8px 0 0">Si el botón no funciona, copia y pega este enlace en tu navegador:</p>
      <p style="font-size:12px;color:#888;word-break:break-all;background:#f5f5f5;padding:10px 12px;border-radius:8px;margin:8px 0 0;font-family:'SF Mono','Menlo','Consolas',monospace">${resetUrl}</p>
      <div style="background:#fff8e6;border:1px solid #f5d97a;border-radius:10px;padding:14px 16px;font-size:13px;color:#7a5a00;line-height:1.5;margin-top:18px">
        ⚠️ Si no has solicitado este restablecimiento, ignora este correo. Tu contraseña actual seguirá siendo válida.
      </div>
    `,
  });

  const text = `Hola ${name || ''},

Has solicitado restablecer la contraseña de tu cuenta de YudBot.

Abre este enlace para crear una nueva contraseña (caduca en 1 hora):

${resetUrl}

Si no has pedido este cambio, ignora este correo. Tu contraseña actual seguirá siendo válida.

— YudBot`;

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: 'Restablece tu contraseña de YudBot',
    text,
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
export async function sendEmailChangeCode(to: string, name: string, code: string, currentEmail: string): Promise<void> {
  const client = getClient();

  const html = baseTemplate({
    preheader: `Confirma tu nuevo email en Yudbot: código ${code}`,
    title: 'Confirma tu nuevo email',
    intro: `Hola ${name || ''},<br/>Has solicitado cambiar el email de tu cuenta de Yudbot a <strong style="color:#000">${to}</strong>. Para confirmarlo, introduce este código:`,
    block: `
      <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:0 0 20px">
        <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#000">${code}</div>
      </div>
      <div style="background:#fff8e6;border:1px solid #f5d97a;border-radius:10px;padding:14px 16px;font-size:13px;color:#7a5a00;line-height:1.5">
        ⚠️ Si no has pedido este cambio, ignora este correo. Tu email actual <strong>${currentEmail}</strong> seguirá activo y nadie tendrá acceso a tu cuenta.
      </div>
      <p style="font-size:13px;color:#888;margin:14px 0 0">El código caduca en 15 minutos.</p>
    `,
  });

  const text = `Hola ${name || ''},

Has solicitado cambiar el email de tu cuenta de Yudbot a ${to}.

Tu código de confirmación es:

  ${code}

Caduca en 15 minutos.

Si no has pedido este cambio, ignora este correo. Tu email actual (${currentEmail}) seguirá activo.

— Yudbot`;

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: `Yudbot: confirma tu nuevo email ${code}`,
    text,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
  }
}

export function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
