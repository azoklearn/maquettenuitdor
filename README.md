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

### Mettre le site en « attente de paiement »

Si tu veux désactiver temporairement le paiement en ligne (par exemple pour un problème Stripe ou le temps de revoir les tarifs) :

1. Sur Vercel, ajoute une variable d’environnement :  
   `PAYMENT_DISABLED=true`
2. Redéploie.

Dans ce mode, le formulaire affiche un message indiquant que le site est en mode « en attente de paiement » et ne redirige plus vers Stripe. Les clients doivent alors te contacter directement pour réserver.

### Configurer le webhook Stripe (recommandé en production)

Pour que les réservations passent en « Payé » même si l’utilisateur ferme la page avant la redirection :

1. Va sur [Stripe Dashboard → Développeurs → Webhooks](https://dashboard.stripe.com/webhooks).
2. **Ajouter un endpoint** :
   - **URL** : `https://www.ndloveroom.com/api/webhook/stripe` (ou ton domaine Vercel).
   - **Événements** : sélectionne `checkout.session.completed`.
3. Après création, ouvre le webhook et copie le **Signing secret** (commence par `whsec_`).
4. Dans Vercel (ou `.env`), ajoute la variable :  
   `STRIPE_WEBHOOK_SECRET=whsec_xxxxx`  
   puis redéploie.

Sans ce secret, le site utilise la page de succès pour confirmer le paiement ; avec le webhook, Stripe notifie le serveur dès que le paiement est reçu.

## Déploiement sur Vercel

- Les fichiers statiques (HTML, CSS, JS, images) sont dans **`public/`** ; Vercel les sert via le CDN.
- L’app Express (`server.js`) est exportée et sert uniquement les routes **`/api/*`**.
- En projet Vercel, définir les variables d’environnement : `STRIPE_SECRET_KEY`, `BASE_URL` (ex. `https://ton-projet.vercel.app`), `RESEND_API_KEY`, `NOTIFY_EMAIL`, et en production le webhook Stripe avec `STRIPE_WEBHOOK_SECRET`.
- **Base de données** : sur Vercel, le module natif SQLite est désactivé ; un stockage **en mémoire** est utilisé (données perdues à chaque cold start). **Pour que les réservations et les dates bloquées restent après un rafraîchissement**, il faut configurer **Redis (Upstash)** — voir ci‑dessous.

### Persistance des réservations sur Vercel (Redis Upstash)

Sans Redis, après un paiement tout semble fonctionner (résa visible, dates bloquées), mais **au prochain rafraîchissement** les résas disparaissent et les dates redeviennent libres, car les données ne sont pas sauvegardées.

1. Crée un compte sur [Upstash](https://upstash.com) et une base **Redis** (gratuit en petit usage).
2. Dans la console Upstash, récupère **REST URL** et **REST Token**.
3. Sur Vercel → ton projet → **Settings → Environment Variables**, ajoute :
   - `KV_REST_API_URL` = l’URL REST (ou `UPSTASH_REDIS_REST_URL`)
   - `KV_REST_API_TOKEN` = le token (ou `UPSTASH_REDIS_REST_TOKEN`)
4. Redéploie.

Après ça, les réservations et les dates bloquées sont enregistrées dans Redis et restent après rafraîchissement. Vérifie que les variables sont bien attachées à l’environnement **Production** (pas seulement Preview), puis **redéploie** le projet.

- **Sans mot de passe** : ouvre `https://ton-domaine/api/health-storage` — tu dois voir `redis_client_ok: true` et un `bookings_count` cohérent. Si `env_url_set` ou `env_token_set` est `false`, les variables ne sont pas visibles par le serveur.
- **Avec l’admin** : `/api/admin/bookings?debug=1` (mot de passe admin) — si `_debug.redis_used` est `true`, Redis est bien utilisé ; le bloc `_debug.storage` reprend le même diagnostic.

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
