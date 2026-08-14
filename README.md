# REBOOT Web

Application web local-first pour suivre le budget hebdomadaire d'un foyer. L’APP compacte regroupe la semaine en cours, les mouvements, les charges et les réserves, dont une réserve Santé créée par défaut. Un broker OAuth minimal permet une autorisation Google Drive durable, sans recevoir les données financières.

## Structure

- `web/` : application exécutable, calculateur, PWA et ressources servies par Nginx.
- `broker/` : service OAuth Node/SQLite ; il conserve uniquement sessions, identité Google et refresh token chiffré.
- `docs/` : PRD, documentation et notes de conception.
- `dev-server.mjs` : serveur web local de développement, sans Docker.
- `Dockerfile` : image Nginx statique.
- `docker-compose.yml` : environnement local de test.

## Procédures de lancement

Toutes les commandes ci-dessous sont à lancer depuis la **racine du projet** : le dossier qui contient `docker-compose.yml`, `web/` et `broker/`.

Sous Windows, par exemple :

```powershell
cd C:\chemin\vers\reboot-web
```

Sous Unraid/Linux, placez-vous dans le dossier du projet Compose, par exemple :

```bash
cd /mnt/user/appdata/reboot-web
```

### 1. Tester uniquement l’interface, sans Google Drive

Cette commande suffit pour développer ou vérifier l’interface locale. Elle démarre le serveur web sur le port `4173`, mais **ne démarre pas le broker OAuth** : l’état « Sync en attente » est donc normal si Google Drive a été configuré.

```powershell
node dev-server.mjs
```

Ouvrez ensuite <http://127.0.0.1:4173/app.html>.

Pour arrêter le serveur : `Ctrl+C`. Pour utiliser un autre port :

```powershell
$env:PORT='4174'
node dev-server.mjs
```

### 2. Tester localement avec une vraie synchronisation Google Drive, sans Docker

Ce parcours démarre deux processus : le broker OAuth sur le port `3000`, puis le site sur le port `4173`. Il utilise le vrai Google Drive associé au compte choisi : évitez donc de modifier des données importantes pendant un essai, ou créez une sauvegarde locale avant.

Dans Google Cloud Console, ajoutez d’abord cette URI aux **URI de redirection autorisés** du client OAuth de type *Application Web* :

```text
http://127.0.0.1:4173/api/oauth/google/callback
```

Google autorise les URI localhost en HTTP pour le développement, mais l’URI doit correspondre exactement à celle déclarée. [Règles Google sur les URI de redirection](https://developers.google.com/identity/protocols/oauth2/web-server?authuser=2)

Ouvrez ensuite deux terminaux PowerShell dans la racine du projet.

Dans le premier, renseignez les variables du broker puis démarrez-le. Remplacez seulement les valeurs entre chevrons ; ne copiez jamais vos secrets dans Git :

```powershell
$env:NODE_ENV='development'
$env:GOOGLE_CLIENT_ID='<client-id Google>'
$env:GOOGLE_CLIENT_SECRET='<client-secret Google>'
$env:GOOGLE_REDIRECT_URI='http://127.0.0.1:4173/api/oauth/google/callback'
$env:REBOOT_TOKEN_ENCRYPTION_KEY='<secret base64 de 32 octets>'
$env:SESSION_SECRET='<second secret, au moins 32 caracteres>'
$env:ALLOWED_ORIGIN='http://127.0.0.1:4173'
node broker/server.mjs
```

Dans le second terminal :

```powershell
cd C:\chemin\vers\reboot-web
$env:OAUTH_BROKER_URL='http://127.0.0.1:3000'
node dev-server.mjs
```

Ouvrez <http://127.0.0.1:4173/app.html>, puis connectez Google Drive depuis l’icône de synchronisation. Les variables PowerShell disparaissent à la fermeture du terminal ; c’est volontaire pour ne pas enregistrer les secrets localement.

### 3. Déployer et tester la vraie synchronisation sur Unraid / Docker

Ce parcours est celui à utiliser pour la synchronisation quotidienne. Il démarre deux conteneurs : `reboot-web` (interface et proxy) et `oauth-broker` (autorisation et leases de synchronisation). Le broker ne contient aucune donnée budgétaire.

#### Créer le fichier de configuration

Depuis la racine du projet, créez `.env` une seule fois. Sous Windows :

```powershell
Copy-Item .env.example .env
notepad .env
```

Sous Unraid/Linux :

```bash
cp .env.example .env
nano .env
```

Renseignez `.env` ainsi, en remplaçant les exemples par vos valeurs. Le domaine doit être votre véritable domaine HTTPS, sans slash final :

```env
GOOGLE_CLIENT_ID=votre-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=votre-client-secret
GOOGLE_REDIRECT_URI=https://budget.exemple.fr/api/oauth/google/callback
REBOOT_TOKEN_ENCRYPTION_KEY=secret-base64-de-32-octets
SESSION_SECRET=autre-secret-different-d-au-moins-32-caracteres
ALLOWED_ORIGIN=https://budget.exemple.fr

# Optionnel : conserver les valeurs par défaut
SYNC_LEASE_TTL_SECONDS=15
TOMBSTONE_RETENTION_DAYS=90
```

Laissez `DATABASE_URL=/app/data/oauth.sqlite` de l’exemple tel quel. Pour générer chacun des deux secrets :

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Exécutez cette commande deux fois : une valeur pour `REBOOT_TOKEN_ENCRYPTION_KEY`, une autre pour `SESSION_SECRET`.

#### Configurer Google Cloud

Dans le projet Google Cloud correspondant :

1. Activez **Google Drive API**.
2. Dans **Google Auth Platform → Accès aux données**, cliquez sur **Ajouter ou supprimer des champs d’application**, puis ajoutez exactement le scope suivant :

   ```text
   https://www.googleapis.com/auth/drive.appdata
   ```

3. Configurez l’écran de consentement OAuth si ce n’est pas déjà fait (et ajoutez les utilisateurs de test si l’application est en mode test).
4. Dans le client OAuth de type **Application Web**, ajoutez exactement :

   ```text
   https://budget.exemple.fr/api/oauth/google/callback
   ```

5. La valeur déclarée dans Google Cloud doit être strictement identique à `GOOGLE_REDIRECT_URI` dans `.env`.

#### Démarrer ou mettre à jour les conteneurs

Depuis la racine du projet sur Unraid :

```bash
docker compose --profile oauth up -d --build --force-recreate
docker compose --profile oauth ps
```

Les deux services `reboot-web` et `oauth-broker` doivent être `running`. Sur Unraid, créez un Proxy Host Nginx Proxy Manager vers `reboot-web:80` et utilisez votre domaine HTTPS. Le navigateur, Nginx et le broker doivent partager ce même domaine ; l’accès direct `http://IP_DU_SERVEUR:8080` (ou `http://localhost:8080/app.html` depuis la machine Docker) sert uniquement à vérifier l’interface. Il ne permet pas la connexion OAuth de production car le cookie de session est volontairement `Secure`.

Pour diagnostiquer sans afficher les secrets :

```bash
docker compose --profile oauth logs --tail 100 oauth-broker reboot-web
curl -i https://budget.exemple.fr/api/oauth/google/status
```

La seconde commande doit répondre `HTTP 200`. Sans session navigateur, le JSON indiquera simplement `connected: false`, ce qui est normal.

La première ouverture sur un nouveau domaine crée un coffre local indépendant : `IndexedDB`, `localStorage`, le `deviceId` et le cache `driveFileId` ne migrent pas entre `localhost`, l’adresse IP et le domaine final. Après la connexion Google, REBOOT recherche toutefois les datasets valides dans `appDataFolder` : le budget Drive reste donc récupérable sans copier ces caches. Le menu **Sauvegardes** permet aussi une sauvegarde et restauration manuelles.

## Images Docker publiées par GitHub

Chaque `push` déclenche un build avec GitHub Actions. Les builds de branches et de pull requests vérifient que les deux images de production se construisent correctement. Un push sur `main` les publie dans GitHub Container Registry :

```text
ghcr.io/za512/reboot-web:latest
ghcr.io/za512/reboot-oauth-broker:latest
```

Chaque publication porte également un tag immuable `sha-…`. Les services Compose utilisent ces images comme tags par défaut tout en gardant `build:` pour le développement local. Pour qu’Unraid puisse les récupérer sans identifiant, rendez les deux packages publics dans GitHub après leur première publication ; sinon, connectez Docker à GitHub Container Registry avec un jeton ayant le droit `read:packages`.

Pour mettre à jour une installation qui utilise les images publiées :

```bash
docker compose --profile oauth pull
docker compose --profile oauth up -d --force-recreate
```

## Tests navigateur dans Docker

Les tests utilisent un navigateur Playwright neuf, sans cache ni service worker persistant :

```bash
docker compose --profile test up --build --abort-on-container-exit --exit-code-from reboot-tests
```

Pour forcer une instance entièrement neuve après une modification :

```bash
docker compose down --remove-orphans
docker compose --profile test up --build --force-recreate --abort-on-container-exit --exit-code-from reboot-tests
```

Ils vérifient la première configuration, les réserves annuelles et temporaires, les corrections et l'historique, le lien calculateur/suivi sans double déduction, les sauvegardes chiffrées, le réimport CSV et le contrôle bancaire local.

## Google Drive et broker OAuth

Le bouton **Connecter Google Drive** démarre un Authorization Code Flow côté broker avec accès offline, `state` à usage unique et PKCE. Le refresh token est chiffré en AES-256-GCM dans SQLite ; le navigateur ne reçoit que des access tokens courts. Après fermeture complète du navigateur, le cookie de session `HttpOnly` permet au broker de renouveler l’accès sans nouvelle fenêtre Google.

Le scope demandé est `https://www.googleapis.com/auth/drive.appdata`. Le fichier `reboot-data.json` est stocké dans `appDataFolder`, dossier privé de l’application. Les téléchargements et envois ont lieu directement entre le navigateur et Google Drive : le broker ne voit jamais leur contenu. L’abstraction frontend sépare le fournisseur de jeton du fournisseur de stockage afin de pouvoir ajouter ultérieurement un fichier partagé `drive.file` pour le mode couple.

### Identité et redécouverte du dataset

`datasetId` est créé une seule fois, puis est stocké dans le payload de `reboot-data.json`. Il identifie le budget, jamais un domaine, un navigateur, un appareil, le broker ou un client OAuth. Le broker conserve seulement une association reconstructible `utilisateur Google → datasetId`, afin d’autoriser les leases ; il ne crée plus de dataset lors de la vérification de connexion.

Après OAuth, le navigateur parcourt en lecture seule les fichiers `reboot-data.json` de `appDataFolder` marqués avec `appProperties.reboot=plain-archive-v1`. Chaque candidat est téléchargé puis validé (enveloppe d’archive REBOOT, version, états et `sync.datasetId` UUID). Avec un budget unique et aucune association broker, REBOOT demande confirmation avant de l’adopter. Avec plusieurs budgets — ou plusieurs copies du même dataset — il les affiche avec date de modification et suffixe d’identifiant : aucun « plus récent » n’est choisi silencieusement. Si le broker connaît déjà ABC et que Drive ne présente que XYZ, c’est un conflit explicite, sans fusion ni écriture.

Cette mécanique permet de retrouver un budget après changement de domaine, de navigateur, de PC/téléphone, ou recréation du volume SQLite. Elle prépare aussi un client Android : il devra appliquer le même protocole de découverte/adoption, sans dépendre de l’URL Web. Un fichier portant simplement le bon nom, l’`appProperty` ou un UUID n’est pas une preuve cryptographique : la validation est structurelle. Une signature ou un MAC du dataset est un futur renforcement utile, à introduire avec une clé de récupération utilisateur.

Pour un même compte Google utilisé sur deux appareils, le broker protège chaque écriture Drive par un lease exclusif de courte durée. Le navigateur découvre d’abord en lecture seule, acquiert ensuite le lease, relit le fichier, fusionne les objets par identifiant et date de modification, écrit puis libère le lease. Si un autre appareil est déjà en cours de synchronisation, REBOOT réessaie avec un délai aléatoire ; les données restent toujours dans IndexedDB. Les suppressions quotidiennes sont conservées comme tombstones pendant 90 jours par défaut pour éviter qu’une ancienne copie ne les recrée. `SYNC_LEASE_TTL_SECONDS` et `TOMBSTONE_RETENTION_DAYS` permettent d’ajuster ces deux valeurs.

Dans Google Cloud, activez **Google Drive API**, configurez l’écran de consentement et déclarez comme URI de redirection exacte la valeur de `GOOGLE_REDIRECT_URI`, par exemple `https://budget.exemple.fr/api/oauth/google/callback`. Le `GOOGLE_CLIENT_SECRET` reste exclusivement dans l’environnement du broker.

Une panne du broker ou de Google produit l’état « Sync en attente » et ne bloque jamais IndexedDB. Seul `invalid_grant` ou une révocation confirmée produit « Drive à reconnecter ».

## Données et confidentialité

La logique métier s'exécute dans le navigateur. Les données sont conservées dans IndexedDB et chiffrées avec Web Crypto. Les CSV sont lus localement. Google Drive est appelé directement par le navigateur ; aucun serveur REBOOT ne reçoit de données financières.

Aujourd’hui, `reboot-data.json` est volontairement une archive `reboot-plain-archive` (`encrypted: false`) afin que les appareils puissent la synchroniser sans secret partagé. Son `payload.states` contient donc en clair les montants, libellés, transactions, réserves, réglages et le `sync.datasetId`. `appDataFolder` limite la visibilité dans l’interface Drive, mais ne chiffre pas ces données côté REBOOT. Le chantier de chiffrement Drive doit être séparé et migrer avec prudence : nouvelle enveloppe chiffrée AES-GCM dans le navigateur, clé dérivée d’un code de récupération (ou une clé de dataset partagée), métadonnées minimales non sensibles pour la découverte, compatibilité lecture des archives historiques en clair, puis opt-in de conversion après sauvegarde vérifiée. Ne pas activer ce changement automatiquement : un navigateur neuf doit pouvoir fournir son information de récupération avant de lire un dataset chiffré.

## Vérifications rapides

```bash
node --check web/app.js
node --check web/sw.js
node --check web/secure-storage.js
node --check web/archive.js
node --check web/drive.js
node --check broker/server.mjs
npm --prefix broker test
docker compose config --quiet
```
