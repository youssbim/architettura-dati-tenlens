import { dettaglioBando } from "@/lib/mongo";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cig: string }> }
) {
  const { cig } = await params;
  try {
    const bando = await dettaglioBando(cig);
    if (!bando) {
      return Response.json({ error: `Bando ${cig} non trovato` }, { status: 404 });
    }
    return Response.json(bando);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
