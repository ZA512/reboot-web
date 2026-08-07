# PRD — REBOOT Web

## Application Web/PWA locale de saisie et de suivi des dépenses

- **Version** : 1.0
- **Date** : 2026-08-07
- **Statut** : spécification produit à remettre à Codex
- **Produit cible** : application Web responsive et installable en PWA
- **Langue initiale** : français
- **Devise initiale** : EUR
- **Périmètre de ce PRD** : gestion des données financières, saisie des dépenses, import CSV, suivi hebdomadaire, stockage local chiffré et synchronisation facultative Google Drive
- **Hors périmètre explicite** : calcul du tampon de démarrage, ancien calcul de coussin, calcul complet du budget initial et stratégie de sortie de découvert

---

# 1. Objet du document

Ce PRD décrit une version purement Web de REBOOT destinée à remplacer ou compléter l’application Android pour la saisie et le suivi quotidien des dépenses.

Cette version doit permettre :

- une utilisation dans un navigateur sur ordinateur, Android et iPhone ;
- une installation comme PWA lorsque le navigateur le permet ;
- un fonctionnement local-first et hors ligne ;
- une saisie rapide des dépenses ;
- un suivi du restant hebdomadaire ;
- un import CSV facultatif pour contrôler les saisies ;
- une synchronisation facultative entre plusieurs appareils ;
- une utilisation par un foyer composé de plusieurs membres ;
- l’absence de transit des données financières par les serveurs REBOOT ;
- un stockage distant facultatif dans Google Drive, après chiffrement dans le navigateur.

Le produit doit rester simple dans son usage quotidien. La préparation et les contrôles peuvent être détaillés, mais l’écran principal doit répondre immédiatement à la question :

> Combien pouvons-nous encore dépenser jusqu’au prochain jour REBOOT ?

---

# 2. Positionnement produit

## 2.1. Ce que REBOOT Web est

REBOOT Web est :

- une application de saisie des dépenses du foyer ;
- un outil de suivi d’un budget hebdomadaire déjà défini ;
- un outil de contrôle des dépenses déclarées ;
- une application locale pouvant fonctionner sans compte ;
- une PWA installable ;
- une application pouvant synchroniser un foyer entre plusieurs appareils ;
- une application pouvant utiliser Google Drive comme stockage chiffré choisi par l’utilisateur ;
- un outil explicable dans lequel toute affectation financière reste visible et modifiable.

## 2.2. Ce que REBOOT Web n’est pas

REBOOT Web n’est pas :

- une banque ;
- un service d’agrégation bancaire obligatoire ;
- un initiateur de paiement ;
- un outil de crédit ;
- une comptabilité générale ;
- un gestionnaire patrimonial ;
- un système de catégorisation exhaustive imposée ;
- un outil qui modifie automatiquement le budget futur ;
- un service centralisé qui stocke les données financières des utilisateurs ;
- un arbitre de l’équité financière dans un couple.

---

# 3. Principes fondateurs

## 3.1. Local-first

La saisie, la consultation du restant et la lecture de l’historique doivent fonctionner sans connexion réseau.

Les données principales sont enregistrées localement dans le navigateur.

La synchronisation distante est facultative.

## 3.2. Aucune donnée financière sur les serveurs REBOOT

Le serveur REBOOT peut fournir :

- les fichiers HTML ;
- le JavaScript ;
- le CSS ;
- le manifeste PWA ;
- le service worker ;
- la documentation ;
- la configuration publique OAuth ;
- les mises à jour statiques de l’application.

Il ne doit jamais recevoir :

- les dépenses ;
- les revenus ;
- les soldes ;
- les libellés bancaires ;
- les historiques CSV ;
- les clés de chiffrement ;
- les jetons Google Drive ;
- les archives de sauvegarde.

Les communications financières autorisées sont uniquement :

```text
Navigateur utilisateur ↔ Google Drive
```

ou :

```text
Navigateur utilisateur ↔ fichier local importé/exporté
```

## 3.3. Chiffrement avant synchronisation

Toute donnée envoyée dans Google Drive doit être chiffrée dans le navigateur avant l’envoi.

Google Drive ne doit recevoir que des enveloppes chiffrées.

La clé de chiffrement du foyer ne doit jamais être transmise au serveur REBOOT.

## 3.4. Saisie minimale

Une dépense doit pouvoir être enregistrée avec :

- un montant ;
- un libellé ou un raccourci.

La date proposée est la date courante.

Les informations complémentaires ne doivent jamais bloquer une saisie simple.

## 3.5. Aucune compensation automatique

Un dépassement ou un surplus ne modifie jamais automatiquement le budget de la semaine suivante.

L’application peut :

- alerter ;
- expliquer ;
- recommander ;
- proposer une correction.

L’utilisateur décide.

## 3.6. Explicabilité

L’utilisateur doit toujours pouvoir comprendre :

- pourquoi une dépense réduit ou non le restant hebdomadaire ;
- pourquoi une dépense est liée à une réserve ;
- pourquoi une opération importée est proposée comme correspondance ;
- pourquoi le restant affiché a changé ;
- quelles données sont locales ;
- quand la dernière synchronisation a eu lieu ;
- quelles opérations restent à vérifier.

---

# 4. Utilisateurs cibles

## 4.1. Utilisateur solo

Un utilisateur peut :

- créer un espace local sans compte ;
- saisir ses dépenses ;
- importer un CSV bancaire ;
- exporter une sauvegarde ;
- connecter son Google Drive ;
- utiliser plusieurs appareils avec le même espace.

## 4.2. Foyer partagé

Un foyer peut comprendre plusieurs membres.

Chaque membre utilise :

- son propre navigateur ;
- son propre appareil ;
- facultativement son propre compte Google.

Les membres voient :

- le même budget hebdomadaire ;
- les mêmes dépenses ;
- le même historique ;
- le même restant ;
- les mêmes réserves ;
- les mêmes opérations à vérifier.

Le budget est commun au foyer.

Le produit ne crée pas de sous-budget obligatoire par personne.

Chaque dépense peut néanmoins mémoriser son auteur pour :

- l’audit ;
- le filtrage ;
- la compréhension de la synchronisation ;
- l’affichage facultatif des dépenses par membre.

## 4.3. Couple avec deux comptes Google

Le produit doit permettre ce scénario :

```text
Membre A → compte Google A
Membre B → compte Google B
Dossier ou fichier REBOOT partagé
Données du foyer communes
```

Le premier membre crée le foyer et le stockage Drive.

Le second membre rejoint le foyer à partir :

- d’un partage Drive ;
- d’un fichier manifeste ;
- d’un QR code ou code de jumelage pour la clé ;
- de son propre compte Google.

Le partage d’un mot de passe Google n’est ni nécessaire ni recommandé.

---

# 5. Périmètre fonctionnel MVP

Le MVP Web doit couvrir :

1. création d’un foyer local ;
2. configuration du jour REBOOT ;
3. saisie manuelle d’une dépense ;
4. modification et suppression d’une dépense ;
5. raccourcis de saisie ;
6. affectation au budget hebdomadaire ;
7. affectation à une charge déjà annualisée ;
8. affectation à une réserve ;
9. transfert interne sans effet budgétaire ;
10. étalement d’une dépense sur plusieurs cycles ;
11. historique hebdomadaire ;
12. tendances sur plusieurs cycles ;
13. import CSV bancaire ;
14. mapping manuel des colonnes CSV ;
15. normalisation des libellés ;
16. détection d’opérations récurrentes ;
17. rapprochement entre saisies et opérations importées ;
18. liste des opérations non rapprochées ;
19. sauvegarde locale ;
20. export et restauration d’une archive chiffrée ;
21. PWA installable et utilisable hors ligne ;
22. synchronisation Google Drive facultative ;
23. foyer multiappareil ;
24. foyer multicomptes Google ;
25. indication de fraîcheur des données ;
26. gestion des conflits sans perte silencieuse.

---

# 6. Hors périmètre MVP

Les éléments suivants ne doivent pas être implémentés dans ce chantier initial :

- calcul du tampon de démarrage ;
- ancien calcul du coussin ;
- calculateur complet du budget annuel initial ;
- plan de sortie de découvert ;
- synchronisation bancaire automatique par agrégateur ;
- initiation de virement ;
- catégorisation comptable complète ;
- recommandations de crédit ;
- multi-devise ;
- partage d’un budget avec droits financiers complexes ;
- budget séparé automatique par membre ;
- prévision du solde bancaire exact ;
- interface d’administration contenant des données financières ;
- stockage central REBOOT des données utilisateur.

Le modèle de données doit néanmoins rester compatible avec l’ajout futur du budget initial et du tampon, sans implémenter leur logique dans ce PRD.

---

# 7. Cycle hebdomadaire

## 7.1. Définition

Le foyer choisit un jour REBOOT.

Un cycle :

- commence à 00:00 locale le jour choisi ;
- couvre sept dates civiles ;
- ne dépend pas d’une durée fixe de 168 heures ;
- conserve le fuseau du foyer ;
- possède un budget applicable ;
- possède un restant calculé.

## 7.2. Écran principal

L’écran principal affiche en priorité :

```text
Il vous reste 147 € jusqu’à samedi
147 € / 230 €
```

Il peut afficher secondairement :

```text
Repère moyen : 36,75 € par jour
```

Le repère quotidien est informatif.

Il ne constitue pas un sous-budget journalier.

## 7.3. Passage au cycle suivant

À chaque nouveau jour REBOOT :

- le cycle précédent est clôturé ;
- son budget historique est conservé ;
- ses dépenses affectées sont conservées ;
- son écart est calculé ;
- le nouveau cycle commence avec le budget prévu ;
- aucun surplus ou déficit n’est transféré automatiquement.

---

# 8. Saisie des dépenses

## 8.1. Saisie rapide

Le formulaire principal demande :

- montant obligatoire ;
- libellé ou raccourci obligatoire ;
- date préremplie ;
- membre ou appareil prérempli ;
- mode de financement prérempli à partir du raccourci ou du dernier choix.

Les champs avancés sont repliés par défaut.

## 8.2. Champs d’une dépense

Une dépense possède :

- identifiant UUID ;
- identifiant du foyer ;
- auteur ;
- appareil d’origine ;
- date de l’achat ;
- date de création ;
- date de dernière modification ;
- montant exact en centimes ;
- devise ;
- libellé ;
- catégorie facultative ;
- nature facultative ;
- mode de financement ;
- cycle d’affectation ;
- statut de rapprochement ;
- référence bancaire facultative ;
- référence de réserve facultative ;
- informations d’étalement facultatives ;
- état actif ou supprimé par tombstone.

## 8.3. Natures facultatives

Les natures proposées sont limitées :

- nécessaire ;
- plaisir ;
- reportable ;
- imprévu.

Une dépense sans nature reste parfaitement valide.

## 8.4. Raccourcis

Un raccourci peut mémoriser :

- libellé ;
- catégorie ;
- mode de financement ;
- nature ;
- réserve ;
- règle d’étalement facultative.

Exemples :

- Courses ;
- Essence ;
- Pharmacie ;
- Cantine ;
- Loisirs ;
- Cadeau ;
- Espèces.

---

# 9. Modes de financement

## 9.1. Budget hebdomadaire

La dépense réduit immédiatement le restant du cycle sélectionné.

## 9.2. Charge déjà annualisée

La dépense ne réduit pas le restant hebdomadaire car elle a déjà été retirée lors du calcul du budget.

Exemples :

- assurance ;
- abonnement ;
- mensualité de crédit ;
- électricité déjà prévue ;
- virement mensuel vers une réserve.

L’opération peut être conservée pour audit et rapprochement.

## 9.3. Réserve

La dépense réduit une réserve réelle ou virtuelle.

### Réserve réelle

La réserve correspond à un compte bancaire distinct.

L’application peut rappeler qu’un virement vers le compte de paiement est nécessaire.

### Réserve virtuelle

La réserve représente une allocation interne sur le même compte bancaire.

Aucun virement réel n’est demandé.

## 9.4. Transfert interne

Un transfert entre deux comptes ou deux réserves du foyer n’est ni un revenu ni une dépense.

Il ne modifie pas le restant hebdomadaire.

## 9.5. Dépense santé

La dépense peut être marquée comme santé pour un suivi agrégé.

Le rapprochement individuel avec chaque remboursement n’est pas obligatoire.

---

# 10. Étalement d’une dépense

Une dépense réelle peut être affectée :

- entièrement au cycle courant ;
- ou répartie sur 1 à 12 cycles.

Pour une dépense de montant `M` répartie sur `N` cycles :

- les `N - 1` premières affectations utilisent le quotient arrondi au centime inférieur ;
- la dernière absorbe le reliquat exact ;
- toutes les affectations futures sont créées dès la validation ;
- la transaction réelle est conservée une seule fois.

Exemple :

```text
28 € sur 3 cycles
9,33 € + 9,33 € + 9,34 €
```

Les étalements simultanés sont additionnés.

Une alerte forte est affichée si :

- les engagements futurs dépassent 50 % du budget d’un cycle ;
- ou rendent un futur restant négatif.

L’utilisateur peut confirmer malgré l’alerte.

Dans le MVP, un étalement confirmé n’est pas modifié partiellement.

Pour corriger une erreur :

- supprimer la dépense et ses affectations ;
- recréer la dépense.

---

# 11. Modification, suppression et audit

## 11.1. Modification

Toute modification crée un nouvel événement.

Les anciennes versions restent auditablement reconstructibles.

## 11.2. Suppression

La suppression logique utilise un tombstone.

Une suppression ne doit pas effacer silencieusement l’historique synchronisé.

## 11.3. Remboursement

Un remboursement peut être lié à une dépense d’origine.

S’il arrive dans le même cycle :

- il peut restaurer le restant de ce cycle.

S’il arrive après :

- il améliore la trajectoire historique ;
- il ne relève pas automatiquement le budget courant.

Le choix final reste à l’utilisateur.

---

# 12. Historique et tendances

Chaque cycle terminé conserve :

- budget applicable ;
- dépenses hebdomadaires affectées ;
- engagements d’étalement ;
- écart positif ou négatif ;
- caractère normal ou exceptionnel ;
- qualité de synchronisation ;
- opérations non rapprochées.

Les fenêtres de lecture sont :

- 4 cycles ;
- 8 cycles ;
- 16 cycles ;
- 32 cycles ;
- 52 cycles.

Calcul principal :

```text
balance observée =
somme des budgets applicables
- somme des dépenses hebdomadaires affectées
```

Seuils MVP :

- moins de 5 % : aucune alerte ;
- de 5 % inclus à 15 % exclus : vigilance ;
- 15 % ou plus : alerte forte.

La couleur ne doit jamais être le seul vecteur d’information.

---

# 13. Import CSV bancaire

## 13.1. Objectif

L’import CSV est facultatif.

Il sert à :

- contrôler les dépenses saisies ;
- détecter les oublis ;
- identifier les charges récurrentes ;
- détecter les variations de montant ;
- rapprocher les opérations bancaires avec les saisies ;
- faire apparaître les opérations non classées.

Le fichier est lu uniquement dans le navigateur.

Il n’est jamais téléversé vers le serveur REBOOT.

## 13.2. Formats acceptés

Le MVP accepte :

- CSV séparé par virgule ;
- CSV séparé par point-virgule ;
- tabulation ;
- encodage UTF-8 ;
- encodage Windows-1252 détecté automatiquement.

Les erreurs d’encodage doivent être visibles et corrigibles.

## 13.3. Assistant de mapping

Après sélection du fichier, l’utilisateur indique :

- ligne d’en-tête ;
- colonne date ;
- colonne libellé ;
- format de date ;
- colonne montant signé ;
- ou colonne débit et colonne crédit ;
- signe utilisé pour les sorties ;
- éventuelle colonne devise ;
- éventuelle colonne identifiant bancaire.

L’outil propose automatiquement un mapping, mais l’utilisateur le valide.

## 13.4. Aperçu

Avant import, afficher :

- cinq à dix lignes ;
- entrées en vert avec signe positif ;
- sorties en rouge avec signe négatif ;
- date ;
- libellé ;
- montant ;
- colonnes retenues.

## 13.5. Gestion des doublons d’import

Une opération importée doit recevoir une empreinte technique.

Cette empreinte peut utiliser :

- date ;
- montant ;
- libellé brut ;
- identifiant bancaire ;
- compte source ;
- index de ligne.

Un nouvel import ne doit pas recréer les opérations déjà importées.

Les doublons incertains sont proposés à la validation.

---

# 14. Normalisation et regroupement des libellés

## 14.1. Principe

Le regroupement utilise une version normalisée du libellé.

Le libellé affiché à l’utilisateur reste le dernier libellé bancaire original.

Exemple affiché :

```text
PAR X UEP SUPER U LES SABL SUPER U
```

Sous le titre, l’application peut afficher :

```text
Regroupé avec : SUPER U LES SABL SUPER U
```

## 14.2. Normalisation

Pour la comparaison uniquement :

- convertir en majuscules ;
- retirer les accents ;
- retirer les dates ;
- retirer les suites de chiffres ;
- retirer la ponctuation ;
- réduire les espaces multiples ;
- retirer certains termes bancaires génériques configurables ;
- conserver les mots discriminants.

Exemples de termes génériques :

- CB ;
- CARTE ;
- PRLV ;
- PRELEVEMENT ;
- VIR ;
- VIREMENT ;
- SEPA ;
- FACTURE ;
- ACHAT ;
- RETRAIT ;
- EUR.

La normalisation ne doit jamais remplacer le libellé brut stocké.

## 14.3. Regroupement prudent

Un libellé seul ne suffit pas toujours.

Le score de regroupement peut combiner :

- libellé normalisé ;
- sens entrée ou sortie ;
- montant ou plage de montant ;
- périodicité ;
- date habituelle ;
- compte source ;
- créancier ou bénéficiaire lorsque disponible.

Une même enseigne peut représenter :

- une dépense hebdomadaire ;
- une dépense d’essence déjà lissée ;
- un transfert ;
- une dépense de réserve.

L’affectation financière finale reste confirmée par l’utilisateur.

---

# 15. Détection des récurrences

## 15.1. Objectif

L’application regroupe les opérations ressemblantes et présente :

```text
Libellé original le plus récent

05/05/2026 — 764,22 €
05/06/2026 — 764,22 €
05/07/2026 — 764,22 €
```

## 15.2. Rythmes détectés

Le moteur peut proposer :

- hebdomadaire ;
- toutes les quatre semaines ;
- mensuel ;
- trimestriel ;
- semestriel ;
- annuel ;
- irrégulier.

## 15.3. Calcul de moyenne mensuelle

La grande majorité des charges structurelles doit être présentée sous forme de coût mensuel moyen.

La moyenne ne doit pas être calculée par opération si plusieurs opérations similaires ont lieu le même mois.

Exemple de trois contrats de prêt :

```text
Août :
764 € + 253 € + 147 € = 1 164 €

Septembre :
764 € + 253 € + 147 € = 1 164 €
```

Le montant mensuel proposé est :

```text
moyenne des totaux mensuels
```

et non :

```text
moyenne de toutes les opérations individuelles
```

## 15.4. Calcul annuel

Pour une opération annuelle :

- afficher le montant de chaque occurrence ;
- proposer la moyenne annuelle ou le montant le plus récent ;
- ne pas la transformer automatiquement en charge mensuelle sans explication.

## 15.5. Validation utilisateur

Pour chaque groupe, l’utilisateur choisit :

- salaire ;
- autre revenu ;
- charge mensuelle ;
- versement vers une réserve ;
- charge annuelle ;
- dépense du budget hebdomadaire ;
- transfert interne ;
- remboursement ;
- santé ;
- ignorer.

Le moteur propose un montant.

L’utilisateur peut :

- valider ;
- modifier ;
- refuser ;
- fractionner un groupe ;
- fusionner deux groupes ;
- mémoriser une règle future.

---

# 16. Rapprochement entre saisies et banque

## 16.1. Principe

L’import bancaire sert à contrôler les saisies manuelles.

Une opération importée peut être :

- rapprochée automatiquement avec forte confiance ;
- proposée comme correspondance ;
- non rapprochée ;
- ignorée ;
- identifiée comme transfert.

## 16.2. Critères de rapprochement

Le score utilise :

- montant exact ou proche ;
- date exacte ou proche ;
- libellé ;
- raccourci ;
- auteur ;
- compte ;
- type de financement ;
- historique de validation.

## 16.3. Règle de prudence

Une opération non reconnue doit par défaut être considérée comme potentiellement liée au restant à vivre.

Elle ne doit pas être exclue silencieusement du suivi.

L’interface demande :

> Cette opération non rapprochée a-t-elle été financée par le budget hebdomadaire ?

Choix :

- oui, réduire le restant ;
- non, charge déjà prévue ;
- réserve ;
- transfert ;
- remboursement ;
- ignorer avec justification facultative.

## 16.4. Liste des écarts

Après import, afficher :

- dépenses saisies mais absentes du relevé ;
- opérations bancaires non saisies ;
- montants habituels qui ont changé ;
- nouveaux prélèvements ;
- revenus attendus absents ;
- opérations en double ;
- transferts probables.

## 16.5. État des données

Trois états simples :

- **Configuration à compléter** ;
- **Données à confirmer** ;
- **Données à jour**.

L’état doit être actionnable et accompagné d’une liste de tâches.

---

# 17. Contrôle périodique sans import

Un utilisateur peut refuser tout import.

L’application doit alors rappeler périodiquement :

- de vérifier les dépenses oubliées ;
- de contrôler les montants des abonnements ;
- de contrôler les assurances ;
- de contrôler les factures variables ;
- de contrôler les hors forfaits ;
- de contrôler les nouveaux prélèvements ;
- de confirmer que le restant affiché correspond encore à la réalité.

Une saisie manuelle récente et complète n’est pas considérée comme intrinsèquement mauvaise.

L’application doit néanmoins indiquer clairement :

```text
Suivi déclaratif
Dernière vérification : 31 juillet
```

---

# 18. Santé

Le suivi Santé est facultatif.

Il peut enregistrer :

- dépenses de santé ;
- remboursements reçus ;
- montants agrégés ;
- corrections.

Le produit ne demande pas obligatoirement de rapprocher chaque remboursement avec chaque consultation.

L’utilisateur peut saisir une fois par mois le total des remboursements observés.

---

# 19. Espèces

Le produit doit permettre :

- un retrait d’espèces comme transfert vers une caisse ;
- la saisie des dépenses payées en espèces ;
- un ajustement manuel de la caisse ;
- l’absence de double comptage entre retrait et dépenses.

Le retrait ne réduit pas automatiquement le budget si les dépenses espèces sont saisies individuellement.

Un mode simplifié peut permettre de considérer le retrait comme dépense immédiate, mais ce choix doit être explicite.

---

# 20. Architecture de stockage local

## 20.1. Journal d’événements

Le stockage principal doit utiliser un journal append-only.

Chaque action métier produit un événement immuable :

- dépense créée ;
- dépense corrigée ;
- dépense supprimée ;
- rapprochement validé ;
- cycle clôturé ;
- règle créée ;
- réserve modifiée ;
- membre ajouté ;
- synchronisation fusionnée.

## 20.2. Identifiants

Chaque événement possède :

- UUID global ;
- identifiant du foyer ;
- identifiant du membre ;
- identifiant de l’appareil ;
- horodatage ;
- type ;
- version du schéma ;
- position locale ;
- données métier chiffrées.

## 20.3. Précision monétaire

Les montants sont stockés en unités mineures exactes.

En JavaScript, ne jamais dépendre d’un `Number` flottant pour le stockage financier.

Utiliser :

- `BigInt` ;
- ou chaîne décimale canonique ;
- avec bornes signées 64 bits.

Aucun arrondi silencieux n’est accepté.

## 20.4. IndexedDB

IndexedDB est le stockage local de référence.

Aucune donnée financière ne doit apparaître en clair dans :

- IndexedDB ;
- localStorage ;
- Cache Storage ;
- service worker ;
- logs ;
- URL ;
- télémétrie.

## 20.5. Snapshots

Pour éviter le rejeu complet d’un grand journal :

- produire des snapshots chiffrés ;
- versionnés ;
- reconstruisibles ;
- vérifiables ;
- supprimables sans perte du journal source.

---

# 21. Chiffrement local

## 21.1. Algorithme

Utiliser Web Crypto avec :

- AES-256-GCM ;
- nonce aléatoire de 96 bits par enveloppe ;
- tag d’authentification de 128 bits ;
- données associées authentifiées ;
- clé non extractible lorsque possible.

## 21.2. Limites

Une clé non extractible stockée dans IndexedDB protège contre une lecture brute du stockage.

Elle ne protège pas contre un JavaScript hostile exécuté sur la même origine.

La sécurité dépend donc également de :

- CSP stricte ;
- absence de scripts tiers ;
- dépendances maîtrisées ;
- déploiement atomique ;
- intégrité du build ;
- absence de `unsafe-eval` hors nécessité technique documentée.

## 21.3. Perte de clé

La perte de la clé doit être détectée.

L’application ne doit jamais :

- recréer silencieusement un nouveau foyer ;
- écraser les données chiffrées existantes ;
- afficher un faux état vide.

Elle doit afficher :

```text
Les données locales existent mais la clé de déchiffrement n’est plus disponible.
Utilisez votre archive ou votre code de récupération.
```

---

# 22. Sauvegarde et récupération

## 22.1. Archive locale

L’utilisateur peut exporter une archive chiffrée complète.

Le format doit :

- être versionné ;
- contenir le journal canonique ;
- être indépendant de la clé locale du navigateur ;
- utiliser une clé spécifique d’archive ;
- être authentifié avant import ;
- refuser les fichiers corrompus ;
- refuser les versions incompatibles sans migration explicite.

## 22.2. Code de récupération

L’archive utilise :

- une clé aléatoire ;
- un code de récupération séparé ;
- un affichage ou QR code ;
- une confirmation utilisateur.

## 22.3. Import

Avant restauration :

- vérifier l’authenticité ;
- vérifier les UUID ;
- décoder tous les événements ;
- reconstruire les projections dans un espace temporaire ;
- refuser une fusion implicite ;
- ne modifier le foyer cible qu’après validation complète.

---

# 23. Synchronisation Google Drive

## 23.1. Objectif

La synchronisation Drive est facultative.

Elle permet :

- plusieurs appareils ;
- plusieurs membres ;
- plusieurs comptes Google ;
- stockage distant chiffré ;
- aucune donnée financière sur les serveurs REBOOT.

## 23.2. Authentification

Utiliser Google Identity Services avec OAuth 2.0 côté navigateur.

Le site utilise un Client ID public.

Aucun secret client n’est placé dans le JavaScript.

Le navigateur reçoit un jeton d’accès temporaire et appelle directement l’API Google Drive.

## 23.3. Permission

Utiliser de préférence :

```text
https://www.googleapis.com/auth/drive.file
```

L’application accède uniquement aux fichiers REBOOT qu’elle crée ou que l’utilisateur sélectionne explicitement.

## 23.4. Stockage solo

Pour un utilisateur solo, deux options sont possibles :

- fichier ordinaire REBOOT ;
- espace applicatif privé.

Le fichier ordinaire est recommandé si l’utilisateur doit pouvoir le partager plus tard.

## 23.5. Stockage foyer partagé

Pour un couple avec deux comptes Google :

- créer un dossier ou un fichier REBOOT partagé ;
- partager avec le second compte ;
- chaque membre autorise REBOOT avec son compte ;
- chaque membre ouvre le même espace ;
- la clé de chiffrement est transmise séparément par QR code ou fichier de récupération.

## 23.6. Aucun passage par le backend

Le flux doit rester :

```text
Navigateur
→ chiffrement
→ API Google Drive
```

Le backend REBOOT ne reçoit pas le payload.

## 23.7. Jetons

Les jetons OAuth :

- restent dans le navigateur ;
- ne sont pas envoyés au serveur REBOOT ;
- ne sont pas écrits en clair dans les journaux ;
- sont renouvelés uniquement via les mécanismes Google autorisés ;
- peuvent nécessiter une nouvelle autorisation après expiration.

---

# 24. Synchronisation multiappareil

## 24.1. Problème à éviter

Un unique fichier JSON réécrit par tous les appareils peut provoquer des écrasements.

Exemple :

```text
Appareil A lit version 10
Appareil B lit version 10
A écrit version 11
B écrit ensuite une autre version 11
```

La modification de A peut être perdue.

## 24.2. Modèle retenu

Utiliser un journal d’événements fusionnable.

Chaque appareil :

- génère des UUID uniques ;
- écrit des événements immuables ;
- conserve une position locale ;
- télécharge les nouveaux événements distants ;
- déduplique par UUID ;
- fusionne ;
- rejoue les projections.

## 24.3. Organisation Drive possible

```text
REBOOT/
└── household-UUID/
    ├── manifest.enc
    ├── snapshots/
    │   └── snapshot-000123.enc
    └── events/
        ├── device-A-2026-08.enc
        ├── device-B-2026-08.enc
        └── device-C-2026-08.enc
```

Chaque appareil écrit principalement dans son propre segment.

## 24.4. Conflits

Les dépenses indépendantes sont toutes conservées.

Pour les modifications concurrentes d’un même objet :

- ne jamais choisir silencieusement ;
- détecter les versions concurrentes ;
- appliquer une règle déterministe documentée ;
- présenter un écran de résolution si le conflit affecte le sens financier.

## 24.5. Fonctionnement hors ligne

Deux membres peuvent saisir hors ligne en même temps.

Après synchronisation :

- toutes les dépenses indépendantes sont conservées ;
- le restant peut devenir négatif ;
- l’application l’explique ;
- le budget suivant reste inchangé.

---

# 25. Fraîcheur des données

L’écran principal doit afficher :

```text
Actualisé il y a 3 min
```

ou :

```text
Hors ligne — dernier état connu à 18:42
```

États possibles :

- local à jour ;
- synchronisation en cours ;
- synchronisé ;
- modifications locales en attente ;
- données distantes disponibles ;
- hors ligne ;
- conflit à résoudre ;
- erreur d’autorisation Drive.

Le dernier restant connu peut rester affiché hors ligne, mais il ne doit jamais être présenté comme garanti exact.

---

# 26. PWA

## 26.1. Installation

La version Web doit être installable lorsque la plateforme le permet.

Sur iPhone, l’application explique le parcours Safari :

```text
Partager → Sur l’écran d’accueil
```

Elle ne simule pas un bouton système inexistant.

## 26.2. Hors ligne

Après une première visite réussie :

- le shell de l’application démarre hors ligne ;
- les ressources statiques sont précachées ;
- les données financières ne transitent jamais par le cache du service worker ;
- IndexedDB reste séparé du cache applicatif.

## 26.3. Mise à jour

Une nouvelle version :

- est téléchargée en arrière-plan ;
- n’interrompt pas une saisie en cours ;
- attend l’activation ;
- remplace atomiquement l’ancien shell ;
- affiche un message clair avant rechargement.

---

# 27. Sécurité d’hébergement

L’hébergement doit appliquer :

- HTTPS obligatoire ;
- CSP stricte ;
- interdiction des scripts tiers ;
- interdiction des scripts inline non hashés ou nonces maîtrisés ;
- interdiction de `unsafe-eval` sauf exception documentée ;
- isolation du contexte ;
- politique de cache adaptée ;
- service worker revalidé ;
- absence de télémétrie financière ;
- absence de logs contenant des données utilisateur ;
- dépendances verrouillées ;
- build reproductible ;
- déploiement atomique.

Cloudflare Pages ou un hébergement statique équivalent peut être utilisé.

---

# 28. UX principale

## 28.1. Navigation

Navigation minimale :

- Aujourd’hui ;
- Ajouter ;
- Historique ;
- Vérifier ;
- Réserves ;
- Synchronisation ;
- Paramètres.

## 28.2. Écran Aujourd’hui

Afficher :

- restant hebdomadaire ;
- budget du cycle ;
- date de fin du cycle ;
- dépenses récentes ;
- engagements futurs ;
- fraîcheur de synchronisation ;
- bouton de saisie rapide.

## 28.3. Écran Ajouter

Ordre :

1. montant ;
2. raccourci ou libellé ;
3. bouton Enregistrer ;
4. options avancées repliées.

## 28.4. Écran Vérifier

Afficher uniquement les éléments nécessitant une action :

- opérations importées non rapprochées ;
- montants récurrents ayant changé ;
- doublons possibles ;
- revenus attendus absents ;
- transferts probables ;
- erreurs de synchronisation.

## 28.5. Écran Synchronisation

Afficher :

- mode local uniquement ou Drive ;
- compte Google connecté ;
- foyer sélectionné ;
- membres ;
- appareils ;
- dernière synchronisation ;
- événements en attente ;
- conflits ;
- bouton Actualiser ;
- bouton Déconnecter Drive sans supprimer les données locales.

---

# 29. Accessibilité

Le produit doit respecter au minimum :

- navigation clavier ;
- contrastes suffisants ;
- libellés accessibles ;
- messages d’erreur explicites ;
- états non transmis uniquement par couleur ;
- zones tactiles adaptées ;
- mise à l’échelle du texte ;
- support des lecteurs d’écran ;
- focus visible ;
- tableaux utilisables sur mobile.

---

# 30. Performance

Objectifs :

- affichage du restant local en moins de 500 ms après ouverture ;
- saisie enregistrée localement en moins de 200 ms perçues ;
- fonctionnement avec au moins 300 000 événements ;
- snapshot pour limiter le rejeu ;
- import annuel CSV sans blocage prolongé de l’interface ;
- traitement CSV dans un Web Worker lorsque nécessaire ;
- progression visible sur les imports importants ;
- possibilité d’annuler un import avant validation finale.

---

# 31. Modèle de données minimal

## 31.1. Household

```text
id
name
currency
timezone
rebootDay
createdAt
schemaVersion
```

## 31.2. Member

```text
id
householdId
displayName
role
createdAt
revokedAt
```

## 31.3. Device

```text
id
memberId
label
createdAt
lastSeenAt
revokedAt
```

## 31.4. WeeklyCycle

```text
id
householdId
startDate
endDate
budgetMinor
status
isExceptional
```

## 31.5. Transaction

```text
id
householdId
authorId
deviceId
occurredAt
createdAt
amountMinor
currency
label
category
nature
fundingMode
cycleId
reserveId
bankReference
reconciliationStatus
deletedAt
```

## 31.6. Allocation

```text
id
transactionId
cycleId
amountMinor
sequence
totalSequences
```

## 31.7. Reserve

```text
id
householdId
name
kindRealOrVirtual
balanceMinor
active
```

## 31.8. ImportedBankOperation

```text
id
importBatchId
sourceAccount
occurredAt
amountMinor
rawLabel
normalizedLabel
bankReference
fingerprint
status
```

## 31.9. Reconciliation

```text
id
bankOperationId
transactionId
confidence
status
confirmedBy
confirmedAt
```

## 31.10. EventRecord

```text
uuid
householdId
memberId
deviceId
eventType
schemaVersion
createdAt
localPosition
payloadCiphertext
```

---

# 32. Règles de calcul obligatoires

## 32.1. Restant hebdomadaire

```text
restant =
budget applicable au cycle
- affectations au budget hebdomadaire
- engagements d’étalement du cycle
+ corrections et remboursements affectés au cycle
```

Ne pas inclure :

- charges déjà annualisées ;
- dépenses de réserve ;
- transferts internes ;
- opérations ignorées.

## 32.2. Moyenne mensuelle d’un groupe importé

Pour chaque mois :

```text
total_mois = somme de toutes les opérations du groupe dans le mois
```

Puis :

```text
moyenne_mensuelle =
somme des totaux mensuels
/ nombre de mois observés pertinents
```

Ne jamais utiliser uniquement :

```text
somme des opérations / nombre d’opérations
```

lorsque plusieurs contrats ou occurrences similaires existent dans le même mois.

## 32.3. Montants exacts

Tous les calculs utilisent les centimes exacts.

Aucun calcul financier ne doit dépendre d’un flottant binaire.

---

# 33. Critères d’acceptation MVP

## 33.1. Saisie

- une dépense est créée hors ligne ;
- le restant change immédiatement ;
- le rechargement conserve la dépense ;
- une correction conserve un historique d’événements ;
- une suppression est propagée par tombstone.

## 33.2. Import CSV

- UTF-8 et Windows-1252 sont supportés ;
- l’utilisateur choisit les colonnes ;
- débit et crédit sont visuellement distincts ;
- un montant signé est supporté ;
- les doublons d’import ne sont pas recréés ;
- les chiffres sont retirés seulement de la clé de comparaison ;
- le libellé original le plus récent reste affiché ;
- plusieurs prêts dans un même mois sont additionnés avant moyenne mensuelle.

## 33.3. Rapprochement

- une saisie peut être rapprochée d’une opération bancaire ;
- une opération non rapprochée reste visible ;
- elle n’est jamais exclue silencieusement ;
- un transfert peut être neutralisé ;
- une charge déjà annualisée ne réduit pas une deuxième fois le budget.

## 33.4. PWA

- l’application démarre hors ligne après installation ;
- les données ne sont pas dans le cache du service worker ;
- une mise à jour ne détruit pas les données locales ;
- Safari iPhone est testé sur appareil réel.

## 33.5. Drive

- connexion OAuth depuis le navigateur ;
- aucun payload financier n’atteint le serveur REBOOT ;
- un fichier chiffré est créé dans Drive ;
- deux appareils du même compte fusionnent leurs événements ;
- deux comptes Google accèdent au même foyer partagé ;
- les événements indépendants ne sont jamais perdus ;
- un conflit sur le même objet est détecté ;
- la déconnexion Drive ne supprime pas les données locales.

## 33.6. Sécurité

- aucun montant ou libellé en clair dans IndexedDB ;
- aucun secret client dans le navigateur ;
- aucune clé de chiffrement envoyée au serveur ;
- une archive corrompue est refusée ;
- une mauvaise clé ne produit pas un faux foyer vide ;
- la CSP interdit les scripts non autorisés.

---

# 34. Ordre de réalisation recommandé

## Phase 1 — Cœur local

- modèle d’événements ;
- stockage IndexedDB chiffré ;
- création du foyer ;
- cycles hebdomadaires ;
- saisie rapide ;
- historique ;
- restant ;
- modification et suppression.

## Phase 2 — Fonctionnalités quotidiennes

- raccourcis ;
- réserves ;
- transferts ;
- étalement ;
- remboursements ;
- tendances ;
- santé ;
- espèces.

## Phase 3 — Import et vérification

- lecture CSV ;
- détection d’encodage ;
- mapping des colonnes ;
- normalisation ;
- groupes récurrents ;
- moyenne mensuelle ;
- rapprochement ;
- opérations non classées.

## Phase 4 — PWA et récupération

- service worker ;
- installation ;
- hors ligne ;
- archive chiffrée ;
- restauration ;
- code de récupération ;
- validation Safari.

## Phase 5 — Google Drive solo

- OAuth ;
- scope `drive.file` ;
- création du stockage Drive ;
- upload chiffré ;
- téléchargement ;
- fusion événementielle ;
- états de synchronisation.

## Phase 6 — Foyer partagé

- dossier Drive partagé ;
- membres ;
- plusieurs comptes Google ;
- jumelage de clé ;
- appareils ;
- révocation ;
- conflits ;
- tests hors ligne simultanés.

---

# 35. Scénarios de test majeurs

## Scénario A — Saisie simple

1. Le foyer dispose de 230 €.
2. Un membre saisit 42 € de courses.
3. Le restant passe à 188 €.
4. L’autre appareil synchronise.
5. Il affiche 188 €.

## Scénario B — Deux membres hors ligne

1. Les deux appareils affichent 188 €.
2. A saisit 30 € hors ligne.
3. B saisit 50 € hors ligne.
4. Les appareils se reconnectent.
5. Les deux événements sont conservés.
6. Le restant final est 108 €.

## Scénario C — Trois prêts

Le CSV contient chaque mois :

- 764 € ;
- 253 € ;
- 147 €.

Le regroupement affiche :

```text
Montant mensuel moyen : 1 164 €
```

et non environ 388 €.

## Scénario D — Libellé avec chiffres

Les opérations :

```text
PRLV 05/05 PRET CONTRAT 12345
PRLV 05/06 PRET CONTRAT 67890
```

peuvent être rapprochées.

L’écran affiche néanmoins le dernier libellé brut.

## Scénario E — Charge déjà prévue

1. Un abonnement mensuel est déjà annualisé.
2. L’opération est importée.
3. L’utilisateur la confirme comme charge mensuelle.
4. Elle ne réduit pas le restant hebdomadaire.

## Scénario F — Dépense oubliée

1. Une opération bancaire de 65 € n’a aucune saisie correspondante.
2. Elle apparaît dans Vérifier.
3. Par défaut elle est présentée comme dépense potentielle du budget hebdomadaire.
4. L’utilisateur choisit son affectation.

## Scénario G — Deux comptes Google

1. A crée le foyer.
2. A partage le dossier avec B.
3. B se connecte avec son propre compte Google.
4. B rejoint le foyer avec le code de jumelage.
5. Les deux voient les mêmes dépenses.
6. Le serveur REBOOT ne reçoit aucune donnée financière.

---

# 36. Décisions explicitement demandées à Codex

Codex doit :

1. traiter ce PRD comme la référence du chantier Web de saisie ;
2. ne pas réintroduire l’ancien coussin ;
3. ne pas implémenter le tampon dans ce chantier ;
4. réutiliser les invariants métier existants lorsque compatibles ;
5. conserver les montants exacts ;
6. privilégier le journal d’événements ;
7. ne jamais stocker de donnée financière en clair ;
8. ne jamais envoyer de donnée financière au backend REBOOT ;
9. documenter toute divergence avec les ADR existants ;
10. produire des tests automatisés pour chaque règle financière ;
11. tester Chrome, Firefox et Safari iPhone réel avant déclaration de compatibilité ;
12. séparer strictement :
   - stockage local ;
   - archive de récupération ;
   - synchronisation Google Drive ;
   - logique métier ;
   - interface utilisateur.

---

# 37. Définition de terminé

Le MVP est terminé lorsque :

- un foyer peut utiliser REBOOT uniquement dans le navigateur ;
- le fonctionnement quotidien reste possible hors ligne ;
- les dépenses sont chiffrées localement ;
- le restant hebdomadaire est exact et explicable ;
- l’import CSV contrôle les saisies ;
- les charges récurrentes sont correctement regroupées ;
- la moyenne mensuelle additionne les opérations d’un même mois ;
- les données peuvent être exportées et restaurées ;
- Google Drive peut synchroniser les données chiffrées sans passage par le backend ;
- deux comptes Google distincts peuvent partager un même foyer ;
- deux appareils hors ligne peuvent fusionner leurs dépenses sans perte ;
- les conflits sont détectés ;
- aucune donnée financière n’apparaît dans les logs, caches, URL ou serveurs REBOOT ;
- les tests de sécurité, de précision et de récupération passent ;
- la compatibilité Safari iPhone a été vérifiée sur un appareil réel.
