const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Nuit d\'Or Loveroom <onboarding@resend.dev>';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || null;

const PACK_LABELS = {
  aucun: 'Sans pack',
  champagne: 'Champagne',
  romance: 'Romance',
  luxe: 'Luxe',
  evasion: 'Évasion'
};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function buildConfirmationHtml(booking) {
  const arrivee = formatDate(booking.date_arrivee);
  const depart = formatDate(booking.date_depart);
  const packLabel = PACK_LABELS[booking.pack] || booking.pack;
  const totalEuros = (booking.amount_cents / 100).toFixed(2);
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body { font-family: sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 1.35rem; margin-bottom: 1rem; }
  .block { margin-bottom: 1rem; }
  .label { color: #6b6b6b; font-size: 0.9rem; }
  .total { font-size: 1.15rem; font-weight: 600; margin-top: 1.25rem; }
  hr { border: none; border-top: 1px solid #eee; margin: 1.25rem 0; }
  p.footer { font-size: 0.85rem; color: #6b6b6b; }
</style></head>
<body>
  <h1>Réservation confirmée — Nuit d'Or Loveroom</h1>
  <p>Bonjour ${booking.nom},</p>
  <p>Votre réservation a bien été enregistrée et le paiement a été reçu.</p>
  <div class="block">
    <span class="label">Dates</span><br>
    Du ${arrivee} au ${depart}
  </div>
  <div class="block">
    <span class="label">Pack</span><br>
    ${packLabel}
  </div>
  <div class="total">Total payé : ${totalEuros} €</div>
  <hr>
  <p>Pour toute question, répondez à cet email ou contactez-nous.</p>
  <p class="footer">— L'équipe Nuit d'Or Loveroom</p>
</body>
</html>
  `.trim();
}

async function sendConfirmationEmail(booking) {
  if (!resend || !booking || !booking.email) return { ok: false, error: 'Email non configuré' };
  try {
    const html = buildConfirmationHtml(booking);
    const to = [booking.email];
    if (NOTIFY_EMAIL) to.push(NOTIFY_EMAIL);
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Réservation confirmée — Nuit d\'Or Loveroom',
      html
    });
    if (error) {
      console.error('Erreur envoi email:', error);
      return { ok: false, error };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    console.error('Erreur envoi email:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendConfirmationEmail };
