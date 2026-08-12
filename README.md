# 🛡️ Lotus — Bot de protection Discord

Bot de sécurité Discord (anti-nuke, anti-raid, anti-spam à venir) écrit en Discord.js v14,
avec persistance MongoDB Atlas. Objectif : rivaliser avec SecurityBot / RaidProtect.

## État actuel

- ✅ **Anti-Nuke** : détection et sanction automatique des actions dangereuses en masse
  (suppression de salons/rôles, bans/kicks en masse, création de webhooks, ajout de bot
  non autorisé, attribution de permissions dangereuses)
- ✅ **Whitelist** : membres jamais sanctionnés (`/lotus-whitelist`)
- ✅ **Panic mode** : lockdown total du serveur en une commande (`/lotus-panic`)
- ✅ **Config par serveur** : salons de logs/alertes, type de sanction (`/lotus-config`)
- ✅ **Logs persistants** en base pour audit
- ✅ **Anti-Raid** : détecte les vagues de joins suspects (âge du compte, pas d'avatar,
  pattern de pseudo) et déclenche un lockdown automatique (vérification renforcée +
  blocage des messages pour @everyone)
- ⏳ Anti-Spam (flood, mentions massives) — prochaine étape
- ⏳ Alt Detection (âge du compte, avatar par défaut, pattern de noms)
- ⏳ Backup & Restore automatique des rôles/salons

## 1. Créer l'application Discord

1. Va sur https://discord.com/developers/applications → **New Application** → nomme-la `Lotus`
2. Onglet **Bot** → **Reset Token** → copie le token (→ `DISCORD_TOKEN`)
3. Active les **Privileged Gateway Intents** : `Server Members Intent` et `Message Content Intent`
4. Onglet **General Information** → copie l'**Application ID** (→ `CLIENT_ID`)
5. Onglet **OAuth2 → URL Generator** :
   - Scopes : `bot`, `applications.commands`
   - Permissions : `Administrator` (le plus simple pour un bot de sécurité — il doit pouvoir
     tout révoquer en cas de nuke), ou a minima : `Ban Members`, `Kick Members`, `Manage Roles`,
     `Manage Channels`, `View Audit Log`, `Manage Webhooks`
   - Utilise le lien généré pour inviter le bot sur ton serveur de test

## 2. MongoDB Atlas (identique à Gurenkai)

1. https://cloud.mongodb.com → crée un cluster gratuit (M0)
2. **Database Access** → crée un utilisateur avec mot de passe
3. **Network Access** → autorise `0.0.0.0/0` (nécessaire pour Render, IP dynamique)
4. **Connect → Drivers** → copie l'URI, remplace `<password>` → `MONGODB_URI`

## 3. Configuration locale

```bash
cp .env.example .env
# Remplis DISCORD_TOKEN, CLIENT_ID, MONGODB_URI, OWNER_ID (ton ID Discord)

npm install
npm run deploy-commands   # enregistre les slash commands auprès de Discord
npm start                  # lance le bot en local pour tester
```

## 4. Déploiement sur Render (identique au setup Gakuran)

1. Push ce repo sur GitHub
2. Sur https://render.com → **New → Web Service** → connecte le repo
3. Configuration :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : Free
4. Onglet **Environment** → ajoute les mêmes variables que dans `.env`
   (`DISCORD_TOKEN`, `CLIENT_ID`, `MONGODB_URI`, `OWNER_ID`) — ne PAS mettre `PORT`,
   Render le fournit automatiquement
5. Deploy. Une fois en ligne, Render te donne une URL du type
   `https://lotus-xxxx.onrender.com`

⚠️ Après le premier déploiement, lance `npm run deploy-commands` une fois (en local,
avec ton `.env` pointant vers le même bot) pour que les slash commandes apparaissent.

## 5. Garder le bot actif 24/7 (UptimeRobot — gratuit)

Le plan gratuit Render met le service en veille après 15 min d'inactivité. Comme pour
Gurenkai :

1. https://uptimerobot.com → crée un compte gratuit
2. **Add New Monitor** → Type `HTTP(s)` → URL = `https://lotus-xxxx.onrender.com/health`
3. Intervalle : 5 minutes

Ça garde le process réveillé en permanence, gratuitement.

## Commandes disponibles

| Commande | Description |
|---|---|
| `/lotus-config logs` | Définit le salon de logs de sécurité |
| `/lotus-config alertes` | Définit le salon d'alertes critiques |
| `/lotus-config punition` | Choisit la sanction (ban/kick/stripRoles/quarantine) |
| `/lotus-config status` | Affiche la config actuelle |
| `/lotus-whitelist ajouter/retirer/liste` | Gère la whitelist anti-nuke |
| `/lotus-panic on/off` | Active/désactive le lockdown total |

## Comment fonctionne l'anti-nuke

Chaque action sensible (suppression de salon, ban, etc.) est comptée par utilisateur
sur une fenêtre glissante de 10 secondes (`config/config.js`). Si le nombre d'actions
dépasse le seuil défini, Lotus applique automatiquement la sanction configurée et
alerte le salon dédié. Les seuils sont volontairement bas par défaut car une action
légitime (un admin qui fait du ménage) se fait rarement à un rythme de nuke — mais
ils sont ajustables par serveur si besoin (fonctionnalité à exposer via `/lotus-config`
dans une prochaine itération).

## Prochaines étapes suggérées

1. **Anti-Raid** : tracker les joins par fenêtre de temps + score de suspicion
   (âge du compte, avatar par défaut) → lockdown auto si seuil dépassé
2. **Alt Detection** dédiée (réutilisable depuis la logique déjà faite sur Gurenkai)
3. **Backup automatique** des rôles/salons pour restauration après un nuke
4. Étendre `/lotus-config` pour permettre de modifier les seuils par serveur
   directement (actuellement seulement en dur dans `config/config.js`)
