import { SeimConfig } from './types';
import { LLMClient } from './ai';
import { SecurityGate } from './security';

/**
 * A lightweight dynamic in-memory document collection database.
 * Provided dynamically to the sandboxed API handlers.
 */
export class SeimCollection {
  private documents: any[] = [];
  private nextId = 1;
  private readonly MAX_DOCS = 10000;

  public insert(doc: any): any {
    if (this.documents.length >= this.MAX_DOCS) {
      this.documents.shift(); // Bounded capacity: evict oldest
    }
    const newDoc = { _id: this.nextId++, ...doc };
    this.documents.push(JSON.parse(JSON.stringify(newDoc)));
    return newDoc;
  }

  public find(query: any = {}): any[] {
    return this.documents.filter(doc => {
      for (const key of Object.keys(query)) {
        if (doc[key] !== query[key]) return false;
      }
      return true;
    });
  }

  public update(query: any, updates: any): number {
    let count = 0;
    for (const doc of this.documents) {
      let matches = true;
      for (const key of Object.keys(query)) {
        if (doc[key] !== query[key]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        Object.assign(doc, JSON.parse(JSON.stringify(updates)));
        count++;
      }
    }
    return count;
  }

  public remove(query: any = {}): number {
    const initialLen = this.documents.length;
    const queryKeys = Object.keys(query);
    if (queryKeys.length === 0) {
      this.documents = [];
      return initialLen;
    }
    this.documents = this.documents.filter(doc => {
      // Keep document if it does NOT match all query keys
      for (const key of queryKeys) {
        if (doc[key] !== query[key]) return true;
      }
      return false; // Matched all query keys: remove it
    });
    return initialLen - this.documents.length;
  }

  // Clear for tests
  public clear(): void {
    this.documents = [];
    this.nextId = 1;
  }
}

// In-memory collections registry
const collections = new Map<string, SeimCollection>();

export function getOrCreateCollection(name: string): SeimCollection {
  let collection = collections.get(name);
  if (!collection) {
    collection = new SeimCollection();
    collections.set(name, collection);
  }
  return collection;
}

// Global register for VM access
(global as any).seimDb = {
  collection: (name: string) => getOrCreateCollection(name),
  clearAll: () => collections.clear()
};

export class FeatureScaffolder {
  private securityGate: SecurityGate;

  constructor(private config: SeimConfig, private llm: LLMClient) {
    this.securityGate = new SecurityGate(config);
  }

  /**
   * Generates a dynamic route handler using the LLM client or local fallback.
   */
  public async scaffoldRoute(method: string, path: string, intent: string): Promise<string> {
    if (!this.config.ai.apiKey) {
      // Local fallback simulator for shopping cart routes
      if (path.includes('cart')) {
        if (method.toUpperCase() === 'POST') {
          return `
            async function handler(req, res) {
              const { productId, quantity } = req.body || {};
              if (!productId) {
                return res.status(400).json({ error: 'productId is required' });
              }
              const collection = global.seimDb.collection('cart_items');
              const inserted = await collection.insert({ productId, quantity: quantity || 1, addedAt: Date.now() });
              res.status(201).json({ success: true, item: inserted });
            }
          `;
        }
        if (method.toUpperCase() === 'GET') {
          return `
            async function handler(req, res) {
              const collection = global.seimDb.collection('cart_items');
              const items = await collection.find({});
              res.json({ success: true, items });
            }
          `;
        }
        if (method.toUpperCase() === 'DELETE') {
          return `
            async function handler(req, res) {
              const collection = global.seimDb.collection('cart_items');
              const deletedCount = await collection.remove({});
              res.json({ success: true, deletedCount });
            }
          `;
        }
      }
      // General fallback
      return `
        async function handler(req, res) {
          res.json({ success: true, message: 'Autonomously scaffolded handler for ${method} ${path}' });
        }
      `;
    }

    const systemPrompt = `You are a Principal Backend Architect. Generate a production-ready Express route handler function for a modern API.
The handler must be an \`async function handler(req, res)\`.

Requirements:
1. Input Validation: Extract and validate required query params or body fields. Return 400 with a helpful JSON error if required inputs are missing.
2. In-Memory / Database Collection Access: Use the async global DB via \`global.seimDb.collection(collectionName)\`:
   - \`await collection.insert(doc)\` -> returns inserted doc with \`_id\`
   - \`await collection.find(query)\` -> returns array of matching docs
   - \`await collection.update(query, updates)\` -> returns count updated
   - \`await collection.remove(query)\` -> returns count removed
3. Return proper HTTP status codes:
   - 200 for successful GET/PUT
   - 201 for successful POST resource creation
   - 204 or 200 for successful DELETE
   - 400 for bad request / missing validation
   - 404 if a queried resource is not found
4. Return structured JSON responses: \`{ success: true, ...data }\` or \`{ success: false, error: "..." }\`.
5. Wrap execution in try/catch to safely return 500 without crashing the server.

Do not import external packages. Respond ONLY with the javascript code containing the \`async function handler(req, res) { ... }\` declaration. Do not include markdown code block characters.`;

    const userPrompt = `Method: ${method.toUpperCase()}
Path: ${path}
Intent & Business Goal: ${intent}

Generate the complete, robust Express route handler.`;

    const rawCode = await this.llm.chat(systemPrompt, userPrompt);
    
    // Safety check code through Security Gate to prevent malicious injections
    const mockCandidate = {
      id: 'scaffold-check',
      routeKey: path,
      pattern: 'scaffold',
      severity: 'low' as const,
      originalCode: '',
      optimizedCode: rawCode,
      confidence: 1.0,
      status: 'pending' as const,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const safety = this.securityGate.validate('', mockCandidate);
    if (!safety.pass) {
      throw new Error(`Scaffolded route code rejected by SecurityGate: ${safety.reason}`);
    }

    return rawCode;
  }
}
