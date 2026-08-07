REBOOT site web v0.2

Premier socle applicatif :
- web/app.html est le suivi quotidien local du cycle REBOOT ;
- web/app.js chiffre l'état du foyer dans IndexedDB avec AES-GCM ;
- web/calculateur.html conserve son parcours de préparation dans un IndexedDB chiffré séparé ;
- web/sw.js met en cache uniquement le shell statique, jamais les données financières ;
- Docker sert uniquement le contenu de web via Nginx sur le port 8080.

Lancement local :
- depuis la racine du projet : docker compose up --build ;
- ouvrir http://localhost:8080/app.html ;
- Docker Desktop doit être démarré.

Le navigateur traite les CSV localement. Aucun backend REBOOT n'est utilisé.

Corrections :
- détection automatique UTF-8 / Windows-1252 pour les CSV bancaires ;
- moyenne mensuelle calculée en additionnant toutes les opérations d’un groupe par mois ;
- dernier libellé bancaire original affiché comme titre ;
- clé normalisée affichée séparément pour expliquer le rapprochement ;
- entrées et sorties visuellement distinguées ;
- filtres Entrées / Sorties et recherche dans les groupes récurrents.
