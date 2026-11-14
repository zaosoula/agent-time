# Validation des quatre lots après beta.56

## Mesures isolées

Copie SQLite cohérente de 646 Mio, mêmes données et réglages pour chaque scénario. Chaque processus reçoit un clone frais ; la capture et les installations de hooks restent arrêtées. Les mesures commencent après la construction du collecteur, avant la première lecture. Il s’agit de caches applicatifs froids, pas d’un vidage du cache disque du Mac. Les caches persistants déjà présents dans la copie restent identiques. Deux passages de la version candidate et un contrôle avec le collecteur beta.56 ont été exécutés. Les durées dépendent aussi des autres travaux du Mac.

| Scénario | Beta.56 contrôle | Candidate passage 1 | Candidate passage 2 | Lectures de fenêtres passage 2 |
|---|---:|---:|---:|---:|
| Home | 2.49 s | 1.99 s | 2.11 s | 1 |
| Deux jours successifs | 3.73 s | 3.71 s | 3.52 s | 2 |
| Time, 7 jours | 29.92 s | 19.90 s | 24.02 s | 7 |
| Time, 30 jours | 213.78 s | 183.38 s | 216.74 s | 30 |

Review synchrone (chemin de beta.56) : 4,16 s puis 6,00 s avant toute réponse. Le chargement en deux étapes montre le jour à 2,06 s puis 2,29 s ; les réponses complètes arrivent à 4,24 s puis 4,81 s. Les quatre réponses complètes ont la même empreinte SHA-256.

Les résultats Home, changement de jour et rapports de 7/30 jours ont chacun exactement la même empreinte entre le collecteur beta.56 et la candidate. Aucun moteur de calcul n’a été changé.

Le pic RSS de Review varie de 537 à 624 Mio pour la candidate et de 612 à 642 Mio pour le chemin synchrone. Les passages ne prouvent pas une réduction systématique de mémoire. Le rapport froid de 30 jours reste coûteux : environ 183 à 217 secondes et 690 à 805 Mio pour la candidate. Ce lot améliore le délai avant la réponse utile de Review, pas le coût du moteur de rapports. Les chiffres détaillés et empreintes sont dans le JSON adjacent. Le compteur `eventReads` du premier passage ne mesurait que les lectures intégrales et vaut zéro ; le deuxième passage instrumente correctement `windowEvents` sous `windowReads`.

## Choix de réalisation

- Le statut courant est chargé sans backlog ; les jours précédents utilisent les caches existants et cèdent la main entre deux jours. Progression indéterminée explicite, sans pourcentage simulé ni nouveau protocole de streaming.
- La méthode synchrone du collecteur reste disponible pour ses consommateurs existants. Le dispatcher attend la méthode coopérative quand elle existe.
- Les détails Billing restent locaux à leur onglet retenu, plutôt que dans le parent Reports : cela empêche leur apparition sur un autre onglet.
- Les transferts internes conservent une copie des paires/segments sélectionnés. Le passage Home → Review ajoute une portée temporaire de visites explicites, effaçable, au lieu de retrouver un groupe plus large par son libellé.
- Le serveur de prévisualisation accepte désormais les commandes autorisées de 10 000 paires UUID sous une limite de 2 Mio ; sa limite antérieure de 64 Kio refusait des sélections valides. La validation des commandes reste inchangée.
- Aucun changement de schéma, d’index, de formule de temps, de politique Billing ou d’observations originales. Aucun score de productivité.

## Vérifications

Tests ciblés : chargement courant avant backlog, réponses périmées, sortie identique coopérative/synchrone, intervalles disjoints, fermeture/focus, affectations et annulations segmentées, navigation avec sauvegarde en cours, transfert exact après extension d’un groupe, export de snapshot sous de nouveaux filtres, portée et couverture inconnue.

La compilation et les tests complets sont exécutés en fin de branche. Aucun code Rust ni schéma du pont natif n’a été modifié. Le bundle principal reste au-dessus du seuil indicatif de 500 Ko de Vite ; son découpage est un travail distinct.

Ces vérifications ont précédé la publication. Après approbation explicite du propriétaire, beta.57 a été publiée et vérifiée le 14 novembre 2026 ; voir le [registre de publication](../beta/release-record.md).


## Contrôle visuel et préservation

Sur la copie isolée, un site de 163 visites (27 minutes observées) a été affecté puis annulé depuis Home. Le passage vers Review conserve exactement ces 163 visites et leur durée. Le panneau agent conserve 31 minutes mesurées et expose ses 11 intervalles séparés, même quand sa première et sa dernière observation sont éloignées. Aucun intervalle entre les deux n’est ajouté.

Le snapshot Billing a gardé ses dates d’origine et son total après changement du jour global ; ses détails restent dans l’onglet Billing. Les modes clair, sombre et système ont été parcourus, ainsi que les largeurs de 390 et 1280 pixels. Le format temporaire du navigateur a été réinitialisé et le mode système restauré.

Échap ferme le panneau et rend le focus au bouton d’origine. Le transfert de focus attend la fin de fermeture du menu ; les menus retenus ne restent pas téléportés sur une page inactive. La valeur par défaut du booléen Vue est testée sur le script réellement compilé.

Après l’affectation puis l’annulation dans le navigateur, les 1 512 772 observations, décisions manuelles, splits, notes, projets/politiques Billing et rapports sauvegardés sont identiques à la copie initiale. Les empreintes et comptes agrégés sont dans `2026-11-14-preservation.json`. Le journal d’audit de l’action et de son annulation reste naturellement présent ; il n’a pas été effacé.

La revue indépendante a signalé un risque d’élargissement par identité de groupe ; la correction a été validée par un test initialement en échec, puis les tests de transfert exact et de navigation sur un sous-ensemble contigu. Aucun autre défaut critique ou important n’a été signalé.


## Résultat final des commandes

- `npm test` : 690 tests réussis, zéro échec (suite complète, environ 130 s). Le test supplémentaire du booléen Vue compilé et les derniers parcours sont aussi couverts par la vérification ciblée suivante.
- `node --test tests/activity-details.test.ts tests/protocol.test.ts tests/review-workspace.test.ts tests/review-row-drop.test.ts tests/home-human-assignment.test.ts tests/human-review-group-actions.test.ts tests/billing-reports-ui.test.ts tests/page-context.test.ts tests/workspace-scope.test.ts tests/preview-request-size.test.ts` : 60 tests réussis, zéro échec, après commit des correctifs finaux.
- `npm run build` : contrôle TypeScript et construction Vite réussis ; avertissement de taille du bundle déjà décrit.
- `git diff --check` : aucune erreur d’espacement.

Implémentation : `6f4082d` (chargement), `8225b36` (détails), `0a9b9ba` (affectations), `6ada478` (portée), `7a4f11c` (transferts exacts et focus après revue). Après ces vérifications, le propriétaire a demandé la publication : les quatre lots et correctifs ont été intégrés dans main puis distribués dans beta.57.
