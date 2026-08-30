import { useEffect, useState } from 'react';

export default function App() {
  const [products, setProducts] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/products', { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Products request failed: ${response.status}`);
        return response.json();
      })
      .then((payload) => setProducts(payload.products))
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setError(requestError.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">SEIM baseline application</p>
        <h1>Validation Store</h1>
        <p>A real React frontend backed by an Express API and observed by SEIM.</p>
      </header>

      <section aria-labelledby="products-title">
        <h2 id="products-title">Products</h2>
        {error ? <p role="alert">{error}</p> : null}
        <div className="grid">
          {products.map((product) => (
            <article className="card" key={product.id}>
              <h3>{product.name}</h3>
              <p>{product.description}</p>
              <strong>${product.price}</strong>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
