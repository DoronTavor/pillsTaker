# Pills Tracker

A personal pharmacy pickup tracker with SMS reminders via Twilio.

## Features

- Track pickup schedules for multiple medications
- Calendar date picker to record each pharmacy visit
- Countdown badges — shows days remaining, due today, or overdue
- Full pickup history per medication with delete option
- SMS reminders sent automatically every morning at 09:00
- Configurable advance notice (e.g. notify 3 days before due date)
- "Run Check Now" and "Send Test SMS" buttons for manual testing
- All data persisted in a local SQLite database

## Medication Schedules

| Medication | Pickup Frequency |
|------------|-----------------|
| Pill A     | Every 30 days   |
| Pill B     | Every 3 months  |
| Pill C     | Every 3 months  |
| Pill D     | Every 3 months  |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your Twilio credentials:

```bash
cp .env.example .env
```

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx
PORT=3000
```

Get your credentials from [twilio.com/console](https://www.twilio.com/console).

### 3. Run the server

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## SMS Notifications

Notifications are sent via Twilio SMS:
- **N days before** the due date (configurable in the UI, default: 3 days)
- **On the due date** itself

Duplicate prevention ensures you won't receive the same reminder twice in one day.

Enter your phone number and save settings in the UI to activate notifications.

## Tech Stack

- **Backend:** Node.js, Express
- **Database:** SQLite (via better-sqlite3)
- **SMS:** Twilio
- **Scheduler:** node-cron
- **Frontend:** Vanilla HTML/CSS/JS
