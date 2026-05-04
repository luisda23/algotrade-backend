import nodemailer from 'nodemailer';

// Configuración SMTP — variables de entorno requeridas:
//   SMTP_HOST   (ej. smtp.hostinger.com)
//   SMTP_PORT   (465 SSL o 587 STARTTLS)
//   SMTP_USER   (ej. noreply@yudbot.com)
//   SMTP_PASS   (la contraseña de la cuenta de email)
//   SMTP_FROM   (opcional, lo que aparece como remitente — por defecto SMTP_USER)
let cachedTransporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP env vars no configuradas: SMTP_HOST, SMTP_USER, SMTP_PASS');
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // true para 465 SSL, false para 587 STARTTLS
    auth: { user, pass },
  });
  return cachedTransporter;
}

const FROM = process.env.SMTP_FROM || `Yudbot <${process.env.SMTP_USER}>`;

export async function sendVerificationEmail(to: string, name: string, code: string): Promise<void> {
  const transporter = getTransporter();

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Tu código de verificación</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a1a">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px">
    <div style="background:#ffffff;border-radius:16px;padding:40px 32px;border:1px solid #e5e5e5">
      <div style="display:inline-block;width:48px;height:48px;border-radius:12px;background:#000000;color:#ffffff;text-align:center;line-height:48px;font-weight:800;font-size:18px;letter-spacing:0.5px;margin-bottom:24px">Y</div>
      <h1 style="font-size:24px;font-weight:800;letter-spacing:-0.02em;margin:0 0 12px;color:#000">Verifica tu email</h1>
      <p style="font-size:15px;line-height:1.55;color:#555;margin:0 0 24px">Hola ${name || ''},<br/>Introduce este código en Yudbot para activar tu cuenta:</p>
      <div style="background:#f5f5f5;border-radius:12px;padding:24px;text-align:center;margin:0 0 24px">
        <div style="font-family:'SF Mono','Menlo','Consolas',monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#000">${code}</div>
      </div>
      <p style="font-size:13px;color:#888;margin:0">Este código caduca en 15 minutos. Si no creaste esta cuenta, ignora este correo.</p>
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12px;color:#888">
      Yudbot · Generador de bots para MetaTrader<br/>
      No respondas a este correo. Para soporte: hola@yudbot.com
    </div>
  </div>
</body>
</html>`;

  const text = `Hola ${name || ''},

Tu código de verificación de Yudbot es:

  ${code}

Caduca en 15 minutos. Si no creaste esta cuenta, ignora este correo.

— Yudbot`;

  await transporter.sendMail({
    from: FROM,
    to,
    subject: `Tu código Yudbot: ${code}`,
    text,
    html,
  });
}

export function generateVerificationCode(): string {
  // 6 dígitos, evita liderar con 0 para que se lean siempre 6
  return String(Math.floor(100000 + Math.random() * 900000));
}
