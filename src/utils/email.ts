import { Resend } from 'resend';

// Variables de entorno requeridas:
//   RESEND_API_KEY  → de https://resend.com/api-keys
//   EMAIL_FROM      → opcional; por defecto onboarding@resend.dev (sin dominio verificado).
//                     Una vez verifiques yudbot.com en Resend, ponlo a:
//                     "Yudbot <noreply@yudbot.com>"

let cached: Resend | null = null;
function getClient(): Resend {
  if (cached) return cached;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY no configurada');
  cached = new Resend(key);
  return cached;
}

const FROM = process.env.EMAIL_FROM || 'Yudbot <onboarding@resend.dev>';

export async function sendVerificationEmail(to: string, name: string, code: string): Promise<void> {
  const client = getClient();

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

  const { error } = await client.emails.send({
    from: FROM,
    to,
    subject: `Tu código Yudbot: ${code}`,
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
