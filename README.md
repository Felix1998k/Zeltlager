# Zeltlager-Bilder-Download

Webseite zum Verwalten und Herunterladen von Zeltlager-Bildern mit Admin-Panel.

## Installation

```bash
npm install
```

## Start

```bash
node server.js
```

Webseite: http://localhost:3000
Admin: http://localhost:3000/admin

## Admin-Passwort

Ohne eigene `.env` Datei lautet das Admin-Passwort: `admin`

Zum Ändern: `.env` Datei erstellen (siehe `.env.example`)

## Features

✅ Bilder hochladen (Admin)
✅ Einmalcodes generieren (Admin)
✅ Codes verwalten (löschen, Status)
✅ Bilder als ZIP herunterladen (mit Code)
✅ Responsive Design
✅ Sicher mit Sessions & Hashing
