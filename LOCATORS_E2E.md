# E2E Locator Inventory (Ticket Flow)

This is the deduplicated locator inventory used by the current JS ticket automation flow.

## 1) Login / Auth (`src/auth/login.js`)
- `text=My Account`
- `[role="heading"]:has-text("My Account")`
- `button:has-text("My Orders")`
- `button:has-text("Profile")`
- `button:has-text("My Addresses")`
- `input[type='tel']:not([data-index])`
- `input[placeholder*='phone' i]`
- `input[placeholder*='mobile' i]`
- `input[name*='phone' i]`
- `button:has-text('Validate')`
- `button:has-text('Verify')`
- `text=/Enter OTP/i`
- `input[data-index]`
- `input[autocomplete='one-time-code']`
- `button[aria-label='Options']`
- `[aria-label*='profile' i]`
- `[role="menu"]`
- `[role="menuitem"]:has-text("My Account")`
- `[role="menuitem"]:has-text("Orders")`
- `[role="menuitem"]:has-text("Logout")`
- `button:has-text('Continue')`
- `button:has-text('Next')`

## 2) Match Page / Tickets Live (`src/session/parallelController.js`)
- `xpath=//p[text()='CATEGORY']`
- `text=/category/i`
- `xpath=//p[text()='How Many tickets?']`
- `text=/how many tickets/i`
- `xpath=//p[text()='CATEGORY']/following-sibling::div[1]/div/div/p[1]`
- `text=/stand/i`
- `button` with labels: `Book Now|Buy Tickets|Select Seats|Get Tickets|Continue`
- `text=/₹?\s?\d{2,}/`

### Optional step locators
- Ticket count section: `xpath=//p[text()='How many tickets?']/following-sibling::div[2]`
- Continue buttons: `button:has-text('Continue'|'Proceed'|'Next')`

## 3) Seat Map Detection (`src/detection/seatMapDetector.js`)
- `svg`
- `svg circle, svg path, svg rect`
- `[data-seat], [data-row], .seat, [class*="seat"]`
- `canvas`
- `#seatmap`, `.seatmap`, `[id*="seat"]`
- `#seating-chart`, `.seating-chart`

## 4) Seat Selection / Next (`src/selection/seatSelector.js`)
- role button names: `/next|continue|proceed|confirm/i`
- `button:has-text('Next')`
- `button:has-text('Continue')`
- `button:has-text('Proceed')`
- `button:has-text('Confirm')`
- `.next-btn`, `[class*="next"]`

### Cart/selection indicators
- `.cart-count`, `.basket-count`, `[data-testid="cart-count"]`
- `.selected-seats`, `.seat-selection`
- `.seat-selected`, `.selected`, `[data-selected="true"]`, `.seat-active`

## 5) Checkout + Addons + Payment (`src/flows/checkoutFlow.js`)

### Addon / checkout entry
- `text=Free Metro Ticket`
- `label:has-text('Free Metro Ticket')`
- `div:has-text('Free Metro Ticket')`
- `[class*="radio"]:has-text("Metro")`
- `text=Metro`
- `text=Paid Parking`
- `[class*="addon"]`
- `[class*="modal"]:has-text("Metro")`
- `button:has-text('Continue'|'Proceed'|'Skip')`

### Checkout page detection
- `text=Checkout`
- `[role="heading"]:has-text("Checkout")`
- `text=My Shopping Bag`
- `text=Total Amount`

### Checkout fields
- `getByRole('textbox', { name: 'First name' })`
- `getByRole('textbox', { name: 'Last name' })`
- `getByRole('textbox', { name: 'Address (House no. / Building)' })`
- `getByRole('textbox', { name: 'Locality (Area / Street)' })`
- `getByRole('textbox', { name: 'Pincode' })`
- `getByRole('textbox', { name: 'City' })`
- `getByRole('textbox', { name: 'State' })`
- `getByRole('checkbox', { name: /I accept/i })`
- `button:has-text('PAY NOW'|'Pay Now')`

### Juspay iframe/payment selectors
- `iframe#in\.juspay\.hyperpay`
- `iframe[id="in.juspay.hyperpay"]`
- `iframe.juspay-mount-iframe`
- UPI tab/input: `[testid="nvb_upi"]`, `text=UPI`, `textbox[name='Username@bankname']`, `input[placeholder*='@']`
- UPI action: `text=VERIFY AND PAY`, `button:has-text('VERIFY AND PAY')`
- Card tab/input: `[testid="nvb_card"]`, `text=Cards`, `textbox[name='Enter Card Number']`, `input[placeholder*='Card Number']`
- Card action: `text=PAY NOW`, `button:has-text('PAY NOW'|'Pay Now')`

## 6) UI Fallback Match Detector (`src/detection/matchDetector.js`)
- `[data-match-id]`, `.match-card`, `.fixture`, `[class*='match']`, `[class*='fixture']`
- `article`, `section`, `li`
- `button`, `a[href]`, `.btn`, `.button`, `[role="button"]`, `.clickable`, `div[onclick]`
