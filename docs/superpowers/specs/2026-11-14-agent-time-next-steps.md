# Agent Time — suite après beta.56

Statut : proposition à examiner après publication ; aucune de ces évolutions n'est implémentée par cette release.

## Objectif

Rendre la compréhension du temps et son affectation rapides et cohérentes entre Home, Review et Reports, sans changer les mesures ni les politiques de facturation.

## Base livrée

Beta.56 partage période et projet ; les recherches et filtres détaillés restent propres à chaque page. Le sélecteur de période est dans la toolbar. Home, Review et Evidence explorent un jour de la période ; les rapports Time et les nouveaux rapports Billing couvrent la période complète. Les rapports sauvegardés restent des snapshots immuables. Les vues de révision, les affectations descendantes, le glisser-déposer et la sélection synchronisée sont en place.

## Périmètre proposé, par priorité

1. Mesurer puis réduire les chargements longs, notamment le statut de révision et ses sept jours précédents. Afficher le jour sélectionné avant les compléments historiques ; garder un retour de chargement fidèle et les requêtes anciennes sans effet sur le nouvel écran.
2. Unifier le panneau de détails : périodes exactes, source, projet, raison d'affectation et distinction entre activité humaine observée, exécution d'agent et compteur déclaré.
3. Réutiliser les mêmes menus et commandes d'affectation pour l'activité humaine éditable dans Home et Review. Depuis un rapport, ouvrir le jour concerné en révision ; ne jamais modifier un snapshot de facturation par glisser-déposer.
4. Clarifier encore les rapports : portée visible, statut sauvegardé, lien vers les éléments disponibles et export fidèle aux résultats affichés.

## Contraintes

- Calculs de temps, comptage minute/seconde, chevauchements, règles d'inactivité et politiques de facturation inchangés.
- Observations originales, décisions manuelles et rapports sauvegardés conservés.
- Aucun score de productivité ; aucune nouvelle collecte de contenu.
- Conserver KeepAlive et le contexte local des pages ; ne pas déplacer ces états dans localStorage.
- Les actions de révision restent explicites et limitées aux observations et segments sélectionnés du jour concerné ; une ligne parent représente ses descendants, jamais une enveloppe temporelle englobant les pauses.
- Un état de chargement, une période sans observation et une couverture inconnue restent distincts.
- Aucun changement de schéma, nouvel index ni nouveau moteur de calcul sans besoin démontré et revue séparée.

## Critères de sortie

Mesures avant/après sur une copie isolée de la même archive volumineuse, sans publier de données client. Régression zéro sur les fixtures de temps et de facturation. Navigation pendant une requête, sélection de segments, annulation et modes clair/sombre/système vérifiés. Chaque lot doit pouvoir être livré indépendamment.
