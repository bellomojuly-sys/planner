# Tasto Azione iPhone — configurazione

L'obiettivo: premere il tasto Azione, dire una frase in italiano, e sentire
Planner rispondere a voce. La stessa frase può aggiungere, completare o spostare
attività, e chiedere cosa resta da fare oggi.

La dettatura avviene **sul telefono**, con il riconoscimento vocale di Apple.
Al server arriva solo il testo: nessun file audio lascia mai l'iPhone, e non
serve alcun servizio di trascrizione a pagamento.

---

## 1. Genera il token

Nell'app → **Impostazioni** → *Tasto Azione iPhone* → **Genera token**.

Copialo subito: viene mostrato una sola volta (il server ne conserva solo
l'hash). Il token registra note vocali e legge **solo il programma di oggi**
quando fai una domanda — non vede il resto del piano, non modifica le
impostazioni e non vede la lista della spesa. Se perdi il telefono, revocalo
dalla stessa schermata.

---

## 2. Crea il Comando Rapido

App **Comandi** → **+** → aggiungi queste azioni nell'ordine:

| # | Azione | Impostazioni |
|---|--------|--------------|
| 1 | **Detta testo** | Lingua: Italiano · Interrompi ascolto: *Dopo una pausa* |
| 2 | **Ottieni contenuto dell'URL** | vedi sotto |
| 3 | **Leggi testo** | Testo: il risultato dell'azione 2 · Lingua: Italiano |

L'azione 3 è ciò che fa parlare Planner: legge a voce cosa ha fatto e, se hai
fatto una domanda, il programma di oggi. Se preferisci non sentire la
risposta, usa **Mostra notifica** al suo posto.

Configurazione dell'azione 2 (tocca ▸ per aprire i dettagli):

- **URL**: `https://TUO-WORKER.workers.dev/api/capture/text`
- **Metodo**: `POST`
- **Intestazioni**:
  - `Authorization` → `Bearer IL_TUO_TOKEN`
  - `Content-Type` → `text/plain`
- **Corpo della richiesta**: `File` → seleziona la variabile **Testo dettato**

Rinomina il comando in **Nota** (o come preferisci).

---

## 3. Assegna il tasto Azione

**Impostazioni iOS** → **Tasto Azione** → scorri fino a **Comando Rapido** →
scegli **Nota**.

Alla prima esecuzione iOS chiede il permesso per microfono e riconoscimento
vocale: concedilo.

---

## Cosa puoi dire

Il modello capisce più azioni in una sola frase e le applica in ordine.

| Frase | Effetto |
|-------|---------|
| «Devo preparare la presentazione per MG entro venerdì» | Nuova attività, area MG, scadenza venerdì, durata e livello di energia stimati |
| «Ho finito la fase 15, ci ho messo due ore» | Segna completata, registra 120 minuti reali, ripianifica le fasi 16-18 |
| «Sposta la revisione del budget a giovedì» | Riprogramma l'attività e tutto ciò che dipende da essa |
| «Prima di scrivere il report devo sentire Marco» | Crea la dipendenza fra le due attività |
| «Finito il latte, comprane due» | Aggiunge il latte alla lista della spesa, quantità 2 |
| «Preso il pane» | Segna il pane come comprato |
| «Cosa devo fare oggi?» | Planner legge a voce gli impegni e le attività che restano oggi |
| «Ho finito il report, cosa mi resta?» | Segna completato e poi legge il resto della giornata |

Le stime di durata, energia, priorità e area sono automatiche. Vengono corrette
nel tempo dai tempi reali che registri completando le attività.

---

## Se la rete non c'è

L'azione **Ottieni contenuto dell'URL** fallisce senza connessione: iOS mostra
un errore e la nota va persa.

Due modi per evitarlo:

- **Nell'app**: la barra di cattura in fondo alla schermata mette in coda le
  note quando sei offline e le invia da sola appena torna la linea.
- **Nel Comando Rapido**: avvolgi l'azione 2 in **Se** → *Altrimenti* →
  **Aggiungi a nota** su una nota dedicata, da riversare nell'app più tardi.

---

## Verifica

Da terminale, per controllare che token e URL siano corretti:

```bash
curl -X POST https://TUO-WORKER.workers.dev/api/capture/text \
  -H "Authorization: Bearer IL_TUO_TOKEN" \
  -H "Content-Type: text/plain" \
  --data "Devo comprare il pane e chiamare il dentista domani"
```

La risposta è una riga di testo in italiano che elenca cosa è stato fatto.

---

# Siri — «Cosa devo fare oggi?»

Questo comando è separato dalla dettatura: non crea e non modifica nulla. Legge
soltanto gli impegni fissi e le attività ancora da fare nella giornata corrente,
in ordine cronologico. Non aggiunge scadenze arretrate, lista della spesa,
domani o commenti dell’AI.

## 1. Genera l’accesso in sola lettura

Nell’app apri **Impostazioni** → **Siri · cosa devo fare oggi?** →
**Prepara il comando Siri** e copia il token mostrato una sola volta.

## 2. Crea il Comando Rapido

Nell’app **Comandi** premi **+** e chiamalo **Cosa devo fare oggi**. Aggiungi:

1. **Ottieni contenuto dell’URL**
   - Metodo: `GET`
   - URL: `https://giulia-personal-planner.giulia-planner.workers.dev/api/plan/today/voice`
   - Intestazione `Authorization`: `Bearer IL_TOKEN_APPENA_COPIATO`
2. **Pronuncia testo**
   - Testo: risultato di **Ottieni contenuto dell’URL**

Da quel momento basta dire: **«Siri, cosa devo fare oggi?»**. La risposta è
testo semplice e funziona senza Claude: deriva direttamente dal piano salvato.
