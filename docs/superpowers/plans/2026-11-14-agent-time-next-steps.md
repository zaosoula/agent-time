# Agent Time — suite après beta.56 : Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Le présent document est une proposition ; ne pas démarrer ces tâches sur la seule base de la demande de publication.

**Goal:** Fluidifier le chargement et rendre les détails, affectations et rapports cohérents dans toute l'app, sans modifier les calculs.

**Architecture:** Conserver le store et les composants retenus en mémoire. Réutiliser les projections, commandes segmentées et résultats sauvegardés existants ; isoler les changements de présentation des calculs et mutations de données.

**Tech Stack:** Vue 3, TypeScript, reka-ui, Tauri/Rust, collecteur Node/SQLite existant.

**Spec:** [Périmètre et contraintes](../specs/2026-11-14-agent-time-next-steps.md).

## Global Constraints

- Calculs de temps, comptage minute/seconde, chevauchements, règles d'inactivité et politiques de facturation inchangés.
- Observations originales, décisions manuelles et rapports sauvegardés conservés.
- Aucun score de productivité ; aucune nouvelle collecte de contenu.
- Conserver KeepAlive et le contexte local des pages ; ne pas déplacer ces états dans localStorage.
- Les actions de révision restent explicites et limitées aux observations et segments sélectionnés du jour concerné ; une ligne parent représente ses descendants, jamais une enveloppe temporelle englobant les pauses.
- Un état de chargement, une période sans observation et une couverture inconnue restent distincts.
- Aucun changement de schéma, nouvel index ni nouveau moteur de calcul sans besoin démontré et revue séparée.

## Review Focus

- Changement rapide de jour/projet pendant une lecture : aucune réponse tardive ne remplace le contexte courant.
- Lecture froide d'une grosse archive : le statut des jours précédents ne doit pas retarder l'affichage du jour sélectionné.
- Sélection partielle d'une activité déjà divisée : l'autre segment reste inchangé après affectation et annulation.
- Rapport sauvegardé ouvert sous un autre filtre global : ses dates, sources, montants et export restent ceux du snapshot.
- Navigation avec panneau ou menu ouvert : pas de panneau téléporté sur la mauvaise page, et retour du focus au bon contrôle.

---

### Lot 1 — Mesurer et raccourcir le chemin de chargement

**Files:** `src/ui/store.ts`, `src/ui/polling.ts`, `src/capture/collector.ts`, `src/capture/protocol.ts`, `src/ui/transport.ts`, `src/ui/LoadingStatus.vue`; tests dans `tests/page-context.test.ts`, `tests/protocol.test.ts` et un nouveau `tests/review-backlog-loading.test.ts`.

**Interfaces:** Réutiliser `dayReviewTransport.status(date, includeBacklog)`, `Collector.dayReviewStatus(date, includeBacklog)` et `pastDayReviewSnapshot(date)`. Garder la réponse `DayReviewStatus` compatible. Toute conversion du contrôleur vers une réponse asynchrone doit être attendue par le dispatcher et ses appelants, sans changer le payload public.

- [ ] Établir la baseline : première ouverture Home/Review, changement de jour, Time sur 7 puis 30 jours ; relever temps jusqu'aux premières données, durée complète, pic RSS et nombre de lectures. Utiliser une copie isolée ; garder uniquement les résultats agrégés.
- [ ] Écrire un test avec le backlog volontairement retardé : le jour sélectionné s'affiche avant lui ; une réponse de l'ancien jour n'affecte pas le nouveau. Vérifier son échec sur le comportement actuel.
- [ ] Charger le statut courant sans backlog, puis compléter les jours précédents en tâche asynchrone bornée, réutilisant les caches existants et laissant le collecteur servir d'autres requêtes entre jours. Ne pas recalculer les durées dans l'interface.
- [ ] Distinguer « chargement du jour » et « autres jours à revoir ». La progression doit refléter les jours réellement traités ; aucun pourcentage simulé.
- [ ] Vérifier : `node --test tests/page-context.test.ts tests/protocol.test.ts tests/review-backlog-loading.test.ts`, puis répéter la baseline. Documenter le gain réel et tout coût mémoire ; ne pas promettre de seuil absolu avant les mesures.
- [ ] Livrer ce lot séparément, avec preuve d'égalité des résultats avant/après.

### Lot 2 — Un panneau de détails commun

**Files:** créer `src/ui/ActivityDetailsPanel.vue` et `src/ui/activity-detail-target.ts`; intégrer dans `src/ui/HumanReview.vue`, `src/ui/SessionExplorer.vue` et `src/ui/ReportsPage.vue`. Réutiliser `src/ui/AgentExecutionDetails.vue`, `src/ui/page-presentation.ts` et les types existants.

**Interfaces:** Définir `ActivityDetailTarget` comme union discriminée : `human` avec `date` et `groups: AppReviewGroup[]`, `agent` avec `date` et `execution: AgentExecution`, `billing` avec `report: Omit<BillingReport,'projectSnapshot'>`. Le composant reçoit `target` et émet `close`, `review(date, ids)` ; l'état d'ouverture et le choix restent locaux à la page retenue.

- [ ] Tester un ensemble de visites séparées : afficher les bornes de chacune sans compter les trous ; tester fermeture, Escape et retour du focus après navigation.
- [ ] Extraire la présentation du panneau humain et réutiliser les détails d'exécution existants. Afficher source, portée, projet, justification et distinction observé/déclaré ; garder les actions de split/notes/règles existantes.
- [ ] Intégrer d'abord Review, puis les détails d'agent sur Home. Un snapshot Billing reste en lecture seule et montre sa portée d'origine.
- [ ] Vérifier les tests de sélection/affectation existants, `tests/page-context.test.ts`, puis les interactions clavier et les trois modes d'apparence dans le navigateur.
- [ ] Livrer sans nouvelle API de mesure ni modification de données.

### Lot 3 — Actions d'affectation cohérentes

**Files:** `src/ui/ReviewProjectActions.vue`, `src/ui/review-workspace.ts`, `src/ui/HumanReview.vue`, `src/ui/TodayPage.vue`, `src/ui/WeeklyReview.vue`; tests `tests/review-workspace.test.ts`, `tests/human-review-group-actions.test.ts` et `tests/review-row-drop.test.ts`.

**Interfaces:** Réutiliser `reviewAssignmentParts(groups)`, `beginReviewDrag(date, groups, transfer)` et `transport.setHumanDecision(pairs, mode, projectPath?, date?, segments?)`. Le panneau du lot 2 émet les identités des visites, pas une plage temporelle reconstruite.

- [ ] Tester la même sélection humaine via menu, raccourci et glisser-déposer : mêmes paires/segments et même résultat après annulation. Garder la limite combinée de 10 000 paires/segments.
- [ ] Réutiliser le menu existant pour les lignes humaines éditables de Home et Review, avec la durée et le nombre de visites concernés affichés avant l'action.
- [ ] Depuis Time/Billing, proposer « Ouvrir le jour dans Review » avec les filtres utiles. Ne pas affecter une ligne agrégée multi-jours ni une ligne d'agent avec la commande de temps humain.
- [ ] Tester changement de date pendant une action, segment `before`/`after`, déplacement vers Unassigned et annulation sans perte de l'autre segment.
- [ ] Vérifier les trois suites ci-dessus et les parcours souris/clavier ; livrer séparément.

### Lot 4 — Portée et justification des rapports

**Files:** `src/ui/WeeklyReview.vue`, `src/ui/BillingReports.vue`, `src/ui/BillingReportExplanation.vue`, `src/ui/UsagePage.vue`; tests `tests/billing-reports-ui.test.ts`, `tests/shared-layouts-ui.test.ts`, `tests/workspace-scope.test.ts`.

**Interfaces:** Consommer les totaux et métadonnées sauvegardés existants. Les exports Billing continuent d'utiliser `reportId` et la portée du snapshot ; les liens de détail utilisent `ActivityDetailTarget` du lot 2.

- [ ] Ajouter une preuve de portée visible : période complète ou jour détaillé, dépôt sélectionné ou groupe facturable complet, résultat vivant ou snapshot sauvegardé.
- [ ] Lier les mesures aux éléments disponibles via le panneau commun, sans déduire une cause d'exclusion que les données n'expliquent pas. Si les preuves ne sont plus disponibles, le dire explicitement.
- [ ] Tester filtre modifié pendant génération, export après changement de politique, couverture inconnue et absence d'observations. Aucune valeur sauvegardée ne doit être reconstruite à partir des filtres actuels.
- [ ] Exécuter les suites ci-dessus, `npm test`, `npm run build` et les tests natifs si le pont est touché. Préparer une nouvelle beta seulement après validation du lot choisi.

## Ordre de livraison recommandé

Lot 1 d'abord : il améliore le parcours quotidien et fournit les mesures. Lot 2 ensuite ; lots 3 et 4 réutilisent son panneau. Chaque lot se termine par une démonstration sur la même archive isolée et un récapitulatif des comportements préservés. La publication de beta.56 n'autorise pas automatiquement l'implémentation de cette proposition.
