# TNT Tax Tracker

A business expense tracking app for TNT Music — vinyl record store.

## Project Overview

A single-file web application for tracking business expenses quarterly and annually, built with no dependencies and local browser storage.

## Tech Stack

- Frontend: Vanilla HTML/CSS/JavaScript (single file app)
- Storage: localStorage (no backend needed)
- No external dependencies
- File: `index.html`

## Expense Categories

Use EXACTLY these categories (no variations):

- Utilities + Security
- Phone
- Internet
- Rent
- Inventory
- Business Supplies
- Office Supplies
- Advertising
- Wages
- Payroll Taxes
- WA State Taxes
- Sales Tax
- General Business Expense
- Repairs and Maintenance
- Leasehold Asset
- Tech Asset

## Core Features

### 1. Add Expense

- Date (date picker)
- Category (dropdown using exact categories above)
- Amount (number input, dollars)
- Description (optional text)
- Save to localStorage

### 2. Quarterly View

- Q1: Jan–Mar | Q2: Apr–Jun | Q3: Jul–Sep | Q4: Oct–Dec
- Show total per category per selected quarter
- Year selector (default: current year)

### 3. Custom Range Report

- Start date + End date picker
- On submit: show amount spent per category for that range
- Show $0 for categories with no spend

### 4. Full Year Report

- Hardcoded to Jan 1 – Dec 31 of selected year
- Amount per category + grand total

### 5. Prompt/Query Interface

- Text input for natural language queries
- Examples: `"Show Q2 2025"` or `"March through June 2025"`
- Parse input and display the matching report

## Data Structure

localStorage key: `"expenses"`

```json
[
  {
    "id": "uuid",
    "date": "2025-01-15",
    "category": "Rent",
    "amount": 2500.00,
    "description": "January rent"
  }
]
```

## UI Requirements

- Clean, professional look suitable for a business owner
- Mobile-friendly
- All features accessible from a single page (tabbed or sectioned layout)
- Export to CSV button on any report view
