// REQ-UI-003 — catch-all under a valid locale: anything that is not a built route renders the locale not-found page.
import { notFound } from 'next/navigation';

export default function CatchAllPage(): never {
  notFound();
}
