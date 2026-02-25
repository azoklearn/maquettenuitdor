# Nuit d'Or Loveroom

Site vitrine / boutique en ligne pour la love room **Nuit d'Or Loveroom**.

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
   *(Un avertissement « prebuild-install deprecated » peut s’afficher : il vient de better-sqlite3 et est sans impact, tu peux l’ignorer.)*
2. **Configurer** : copier `.env.example` en `.env`, renseigner `STRIPE_SECRET_KEY`.
3. **Démarrer** : `npm start` puis ouvrir **http://localhost:3000**.

En production : définir BASE_URL et le webhook Stripe (STRIPE_WEBHOOK_SECRET). Tarifs dans .env.

## Déploiement sur Vercel

- Les fichiers statiques (HTML, CSS, JS, images) sont dans **`public/`** ; Vercel les sert via le CDN.
- L’app Express (`server.js`) est exportée et sert uniquement les routes **`/api/*`**.
- En projet Vercel, définir les variables d’environnement : `STRIPE_SECRET_KEY`, `BASE_URL` (ex. `https://ton-projet.vercel.app`), `RESEND_API_KEY`, `NOTIFY_EMAIL`, et en production le webhook Stripe avec `STRIPE_WEBHOOK_SECRET`.
- **Base de données** : sur Vercel, le module natif SQLite est désactivé pour éviter les crashs ; un stockage **en mémoire** est utilisé (données perdues à chaque cold start). Les créneaux « déjà réservés » ne sont donc pas bloqués entre invocations. L’email de confirmation après paiement reste envoyé grâce aux métadonnées Stripe. Pour une vraie persistance sur Vercel, prévoir une base externe (Vercel Postgres, Turso, etc.).

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
