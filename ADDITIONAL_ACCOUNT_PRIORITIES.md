# Additional Account Stand Priority Recommendations

This document suggests `standPriority` values for **1 to 3 newly added accounts**.

The goal is to **complement the existing 6 configured accounts** and reduce unnecessary collisions, instead of making every new account chase the exact same stand sequence.

## Current Assumption

Your existing 6 accounts are already configured and should remain unchanged.

This file only covers recommendations for **extra accounts added later**.

## Strategy

The new accounts should:

- avoid being exact duplicates of the existing strongest paths where possible
- add pressure to strong stands that are still worth targeting
- vary fallback order so all accounts do not rotate through stands in the same sequence

## If 1 New Account Is Added

Use this priority:

```json
["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"]
```

### Why

- keeps **BOAT C STAND** as a strong opening choice
- uses a different fallback order from typical duplicated paths
- gives a good spread into **SUN PHARMA A STAND** and **E STAND**

## If 2 New Accounts Are Added

Use these priorities:

### New Account 1

```json
["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"]
```

### New Account 2

```json
["PUMA SHANTA RANGASWAMY B STAND", "SUN PHARMA A STAND", "CONFIRMTKT H UPPER"]
```

### Why

- one account reinforces **BOAT C STAND** with a different fallback path
- one account opens directly on **PUMA SHANTA RANGASWAMY B STAND**
- fallback coverage spreads across **SUN PHARMA A**, **E STAND**, and **H UPPER**

## If 3 New Accounts Are Added

Use these priorities:

### New Account 1

```json
["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"]
```

### New Account 2

```json
["PUMA SHANTA RANGASWAMY B STAND", "SUN PHARMA A STAND", "CONFIRMTKT H UPPER"]
```

### New Account 3

```json
["E STAND", "BOAT C STAND", "PUMA SHANTA RANGASWAMY B STAND"]
```

### Why

- spreads opening attempts across **BOAT C**, **PUMA B**, and **E STAND**
- avoids making all new accounts share the same first stand
- keeps fallback routes diversified enough for fast ticket drops

## Ready-to-Copy Snippets

### One extra account

```json
{
  "id": "NEW_1",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"],
  "paymentType": "UPI"
}
```

### Two extra accounts

```json
{
  "id": "NEW_1",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"],
  "paymentType": "UPI"
}
```

```json
{
  "id": "NEW_2",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["PUMA SHANTA RANGASWAMY B STAND", "SUN PHARMA A STAND", "CONFIRMTKT H UPPER"],
  "paymentType": "UPI"
}
```

### Three extra accounts

```json
{
  "id": "NEW_1",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["BOAT C STAND", "SUN PHARMA A STAND", "E STAND"],
  "paymentType": "UPI"
}
```

```json
{
  "id": "NEW_2",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["PUMA SHANTA RANGASWAMY B STAND", "SUN PHARMA A STAND", "CONFIRMTKT H UPPER"],
  "paymentType": "UPI"
}
```

```json
{
  "id": "NEW_3",
  "phone": "<phone>",
  "enabled": true,
  "standPriority": ["E STAND", "BOAT C STAND", "PUMA SHANTA RANGASWAMY B STAND"],
  "paymentType": "UPI"
}
```

## Practical Note

If, on drop day, one stand clearly looks stronger than expected, you can still intentionally duplicate that stand for one more account.

But as a default strategy, the above distribution is a good balance between:

- chasing strong stands
- reducing direct collisions
- improving the chance that at least some accounts confirm tickets