# Tasto Azione iPhone — configurazione

L'obiettivo: premere il tasto Azione, dire una frase in italiano, in inglese
o mescolando le due, e sentire
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

## 2. Ricrea il Comando Rapido conversazionale

Il vecchio comando `POST /api/capture/text` continua a funzionare per le note
singole. Per ricevere domande come «Dove devi andare?» e confermare il piano dal
Tasto Azione, ricrea una volta il comando usando
`POST /api/capture/action-button`.

Non aggiungere **Mostra notifica**: la sola risposta utente è **Leggi testo**, in
modo da non ricevere due notifiche per la stessa azione.

### Blocco iniziale

App **Comandi** → **+** → aggiungi queste azioni nell'ordine:

1. **Detta testo**
   - Lingua: **Predefinita**.
   - Interrompi ascolto: **Dopo una pausa**.
2. **Rileva lingua** sul `Testo dettato` e salva il risultato nella variabile
   `Lingua iniziale`.
3. **Ottieni contenuto dell'URL**:
   - URL: `https://giulia-personal-planner.giulia-planner.workers.dev/api/capture/action-button`
   - Metodo: `POST`
   - Intestazione `Authorization`: `Bearer IL_TUO_TOKEN`
   - Intestazione `Content-Type`: `application/json`
   - Corpo JSON:
     - `action` = `start`
     - `text` = variabile `Testo dettato`
4. **Imposta variabile** `Risposta Dani` sul risultato di **Ottieni contenuto dell'URL**.

### Ciclo delle domande

5. Aggiungi **Ripeti 3 volte**. Dentro al ciclo:
   1. **Ottieni valore dizionario** `state` da `Risposta Dani`.
   2. **Se** il valore è `needs_input`:
      - ottieni `spoken` da `Risposta Dani`;
      - usa il blocco voce descritto sotto per leggerlo;
      - **Detta testo** con lingua **Predefinita**;
      - ottieni `sessionId` da `Risposta Dani`;
      - **Ottieni contenuto dell'URL** sullo stesso URL, con le stesse intestazioni e corpo JSON:
        - `action` = `reply`
        - `sessionId` = il valore appena ottenuto
        - `text` = il nuovo `Testo dettato`;
      - **Imposta variabile** `Risposta Dani` sul nuovo risultato.
   3. Chiudi **Se** e **Ripeti**.

Tre cicli coprono le domande massime della Fase 1: orario, luogo e durata.

### Conferma finale

6. Ottieni `state` da `Risposta Dani`.
7. **Se** `state` è `ready`:
   - ottieni e leggi `spoken`;
   - aggiungi **Scegli dal menu** con `Conferma` e `Annulla`;
   - nel ramo `Conferma`, richiama lo stesso URL con:
     - `action` = `confirm`
     - `sessionId` = valore `sessionId` di `Risposta Dani`;
   - nel ramo `Annulla`, richiama lo stesso URL con:
     - `action` = `cancel`
     - `sessionId` = valore `sessionId` di `Risposta Dani`;
   - imposta nuovamente `Risposta Dani` sul risultato della chiamata;
   - ottieni e leggi `spoken` una sola volta.
8. **Altrimenti**, se lo stato iniziale era già `done`, ottieni e leggi subito
   `spoken`: è il caso di note normali, completamenti e domande sull'agenda.

### Blocco voce da riutilizzare

Ogni volta che le istruzioni dicono «leggi `spoken`»:

1. **Se** `Lingua iniziale` contiene `it`:
   - **Leggi testo**, lingua Italiano (Italia), voce **Alice**.
2. **Altrimenti**:
   - **Leggi testo**, lingua Inglese (Stati Uniti), voce **Samantha**.
3. **Fine Se**.

**Perché la lingua della dettatura non va fissata su Italiano.** Con
«Lingua: Italiano» il riconoscimento vocale trascrive l'inglese come se fosse
italiano, quindi al server arriva testo sbagliato prima ancora che Planner
lo interpreti. Con «Predefinita» iOS riconosce entrambe le lingue, e Planner
capisce anche le frasi miste.

**Perché «contiene» e non «è».** «Rileva lingua» può restituire `it`,
`it_IT` o il nome della lingua: «contiene it» funziona in tutti questi casi.

Il blocco voce fa parlare Dani: legge cosa ha fatto e, se hai fatto una
domanda, il programma del giorno richiesto, nella lingua in cui hai parlato.

Il valore di `Authorization` è `Bearer`, uno spazio e il token intero (43
caratteri, può contenere trattini). Se il server risponde `unauthorized`, il
token è incompleto o revocato: generane uno nuovo.

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
curl -X POST https://giulia-personal-planner.giulia-planner.workers.dev/api/capture/action-button \
  -H "Authorization: Bearer IL_TUO_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"action":"start","text":"Domani pianifica barbecue"}'
```

La risposta è JSON. `state` vale `needs_input`, `ready` oppure `done`; il
Shortcut legge `spoken` e conserva soltanto l'opaque `sessionId` necessario a
continuare o confermare la propria proposta.

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
