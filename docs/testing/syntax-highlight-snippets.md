# Syntax Highlighting Test Snippets

Paste these into a Babelr message to verify code block highlighting.
Each should render with Shiki's github-dark theme coloring.

---

## JavaScript

```js
const greet = (name) => `Hello, ${name}!`;
export default async function fetchData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

## TypeScript

```typescript
interface User {
  id: string;
  name: string;
  roles: readonly string[];
}

function isAdmin(user: User): boolean {
  return user.roles.includes('admin');
}
```

## Python

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class Tower:
    domain: str
    name: str
    federation_mode: str = "open"

    def is_federated(self) -> bool:
        return self.federation_mode != "isolated"
```

## Rust

```rust
use std::collections::HashMap;

fn word_count(text: &str) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}
```

## Go

```go
package main

import (
    "fmt"
    "net/http"
)

func handler(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Hello from Tower %s", r.Host)
}

func main() {
    http.HandleFunc("/", handler)
    http.ListenAndServe(":3000", nil)
}
```

## SQL

```sql
SELECT u.preferred_username, COUNT(m.id) AS message_count
FROM actors u
JOIN objects m ON m.attributed_to = u.id
WHERE m.type = 'Note'
  AND m.published > NOW() - INTERVAL '7 days'
GROUP BY u.preferred_username
ORDER BY message_count DESC
LIMIT 10;
```

## Bash

```bash
#!/bin/bash
set -euo pipefail

echo "Starting Babelr Tower..."
export DATABASE_URL="postgresql://babelr:babelr@localhost:5432/babelr"
npm run build
node packages/server/dist/index.js &
echo "Tower running on port 3000"
```

## JSON

```json
{
  "@context": "https://www.w3.org/ns/activitystreams",
  "type": "Create",
  "actor": "https://tower.example/users/alice",
  "object": {
    "type": ["Note", "WorkItem"],
    "content": "Fix the login bug",
    "babelr:priority": "high"
  }
}
```

## HTML + CSS

```html
<div class="tower-card">
  <h2>My Tower</h2>
  <p>A federated workspace</p>
  <button onclick="join()">Join</button>
</div>
```

```css
.tower-card {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 1.5rem;
  color: #e2e8f0;
}

.tower-card h2 {
  color: #3b82f6;
  margin: 0 0 0.5rem;
}
```

## YAML

```yaml
services:
  babelr:
    image: babelr/tower:latest
    environment:
      DATABASE_URL: postgresql://babelr:babelr@db:5432/babelr
      VAPID_PUBLIC_KEY: ${VAPID_PUBLIC_KEY}
    ports:
      - "3000:3000"
    depends_on:
      - db
```

## No language tag (should render plain)

```
This code block has no language tag.
It should render as plain monospace text
with no syntax coloring.
```
