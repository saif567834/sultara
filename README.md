# SULTARA – storefront with Razorpay and COD

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and fill in MongoDB Atlas URI and Razorpay TEST keys (Razorpay dashboard > Settings > API Keys).
3. `npm start`, open http://localhost:3000

## Razorpay webhook
Dashboard > Settings > Webhooks > add `https://YOUR-DOMAIN/api/payments/webhook`, events `payment.captured` and `payment.failed`, and put the secret in `RAZORPAY_WEBHOOK_SECRET`.

## Test payment (test mode)
Use Razorpay test UPI `success@razorpay` or their published test card numbers. Check the order shows `paymentStatus: paid` in MongoDB.

## Deploy on Render
New Web Service from your GitHub repo: build `npm install`, start `npm start`, add the env vars in Render settings. Never commit `.env`. Switch to live keys only after test payments work.

## Admin panel
Open `/admin.html` on your site and log in with ADMIN_EMAIL and ADMIN_PASSWORD. Add, edit, hide or delete products, set stock, and update order status. A first product is created automatically with stock 100: change it to your real stock.

## Order tracking
Customers open `/track-order`, enter order ID + the phone used on the order, and get a 6-digit code. The code is sent through the JSON webhook in `SMS_WEBHOOK_URL` (connect any SMS or WhatsApp provider). Without it, the code is only printed in the server log when NODE_ENV is not `production`, so real customers cannot track until a provider is connected. In the admin Orders tab, set status and shipping details (courier, tracking number, link, estimated date); the tracking page shows them live.

## Not built yet
Customer login and accounts, coupons, reviews, invoices, refunds, emails, analytics dashboard, React version. Orders are stored in the `orders` collection for now.
