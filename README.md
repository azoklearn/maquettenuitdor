# Nuit d'Or Loveroom

Site vitrine / boutique en ligne pour la conciergerie love room **Nuit d'Or Loveroom**.

## Contenu du site

- **Accueil** (`index.html`) : hero, avantages, appel à l’action vers la réservation.
- **Réservation** (`reservation.html`) : formulaire dates + packs romantiques, **paiement Stripe**. Les créneaux déjà payés sont automatiquement indisponibles dans le calendrier.

## Design

- Couleurs : noir et blanc, style moderne et épuré.
- Typographies : Cormorant Garamond (titres), Outfit (texte).
- Responsive : adapté mobile et desktop.

## Logo

Pour afficher votre logo à la place du texte « Nuit d'Or Loveroom » :

1. Créez un dossier `images` à la racine du projet.
2. Déposez votre fichier logo (ex. `logo.png`).
3. Dans `index.html` et `reservation.html`, remplacez le contenu du lien avec la classe `logo` par :
   ```html
   <img src="images/logo.png" alt="Nuit d'Or Loveroom">
   ```

## Lancer le site (Option B — Stripe + backend)

1. **Installer** : `npm install`
2. **Configurer** : copier `.env.example` en `.env`, renseigner `STRIPE_SECRET_KEY`.
3. **Démarrer** : `npm start` puis ouvrir **http://localhost:3000**.

En production : définir BASE_URL et le webhook Stripe (STRIPE_WEBHOOK_SECRET). Tarifs dans .env.

## Déploiement sur Vercel

- Les fichiers statiques (HTML, CSS, JS, images) sont dans **`public/`** ; Vercel les sert via le CDN.
- L’app Express (`server.js`) est exportée et sert uniquement les routes **`/api/*`**.
- En projet Vercel, définir les variables d’environnement : `STRIPE_SECRET_KEY`, `BASE_URL` (ex. `https://ton-projet.vercel.app`), `RESEND_API_KEY`, `NOTIFY_EMAIL`, et en production le webhook Stripe avec `STRIPE_WEBHOOK_SECRET`.
- **SQLite** : sur Vercel la base est en **`/tmp`** (éphémère). Les réservations ne sont pas persistées entre déploiements / cold starts. Pour une vraie persistance, utiliser plus tard une base type Vercel Postgres ou Turso.

## Structure des fichiers

```
nuitdor/
├── public/             # Fichiers statiques (servis par Vercel CDN)
│   ├── index.html
│   ├── reservation.html
│   ├── css/, js/, images/
├── server.js           # Express (API uniquement en prod)
├── server/db.js, server/mail.js
├── data/               # Base SQLite (local)
├── vercel.json
└── README.md
```
