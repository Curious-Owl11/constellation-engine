import type { APIRoute } from 'astro';
import neo4j, { type Driver, type Session } from 'neo4j-driver';

export const GET: APIRoute = async ({ params }) => {
  const clientId = params.id ?? 'rachel';

  const uri = process.env['NEO4J_AURA_URI'];
  const user = process.env['NEO4J_USER'] ?? 'neo4j';
  const password = process.env['NEO4J_PASSWORD'] ?? '';

  if (!uri) {
    return new Response(
      JSON.stringify({ nodes: [], edges: [], error: 'NEO4J_AURA_URI not configured' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let driver: Driver | null = null;
  let session: Session | null = null;

  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    session = driver.session();

    const result = await session.run(
      `MATCH (n)-[r]->(m)
       WHERE n.clientId = $id OR n.id = $id OR m.clientId = $id
       RETURN n, r, m LIMIT 500`,
      { id: clientId }
    );

    if (result.records.length === 0) {
      // Also try isolated nodes with this clientId
      const nodeResult = await session.run(
        `MATCH (n) WHERE n.clientId = $id OR n.id = $id RETURN n LIMIT 200`,
        { id: clientId }
      );

      if (nodeResult.records.length === 0) {
        return new Response(
          JSON.stringify({ nodes: [], edges: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Pre-compute gap scores for isolated nodes too
      const gapScoresResult = await session.run(
        `MATCH (role:Role)
         WITH count(role) as totalRoles
         MATCH (skill:Skill)
         OPTIONAL MATCH (skill)<-[:REQUIRES]-(r:Role)
         WITH skill, count(r) as rolesRequiring, totalRoles
         WHERE rolesRequiring > 0
         RETURN skill.id as skillId,
                toFloat(rolesRequiring) / toFloat(totalRoles) as gapScore,
                rolesRequiring
         ORDER BY gapScore DESC
         LIMIT 20`,
        {}
      );

      const gapScores = new Map<string, { score: number; rolesRequiring: number }>();
      for (const record of gapScoresResult.records as any[]) {
        const skillId = String(record.get('skillId'));
        const score = record.get('gapScore') as number;
        const rolesRequiring = record.get('rolesRequiring').toNumber();
        gapScores.set(skillId, { score, rolesRequiring });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodes = nodeResult.records.map((record: any) => {
        const n = record.get('n');
        const props = n.properties as Record<string, unknown>;
        const id = String(props['id'] ?? n.identity);
        const gapData = gapScores.get(id);
        return {
          data: {
            id,
            label: String(props['name'] ?? props['label'] ?? props['title'] ?? id),
            type: String((n.labels as string[])?.[0] ?? 'Unknown'),
            gapScore: gapData?.score ?? 0,
            rolesRequiring: gapData?.rolesRequiring ?? 0,
          },
        };
      });

      return new Response(
        JSON.stringify({ nodes, edges: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const nodeMap = new Map<string, object>();
    const edges: object[] = [];

    // Pre-compute gap scores for what-if mode
    // Gap score = (roles requiring this skill) / (total roles)
    const gapScoresResult = await session.run(
      `MATCH (role:Role)
       WITH count(role) as totalRoles
       MATCH (skill:Skill)
       OPTIONAL MATCH (skill)<-[:REQUIRES]-(r:Role)
       WITH skill, count(r) as rolesRequiring, totalRoles
       WHERE rolesRequiring > 0
       RETURN skill.id as skillId,
              toFloat(rolesRequiring) / toFloat(totalRoles) as gapScore,
              rolesRequiring
       ORDER BY gapScore DESC
       LIMIT 20`,
      {}
    );

    const gapScores = new Map<string, { score: number; rolesRequiring: number }>();
    for (const record of gapScoresResult.records as any[]) {
      const skillId = String(record.get('skillId'));
      const score = record.get('gapScore') as number;
      const rolesRequiring = record.get('rolesRequiring').toNumber();
      gapScores.set(skillId, { score, rolesRequiring });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const record of result.records as any[]) {
      const n = record.get('n');
      const m = record.get('m');
      const r = record.get('r');

      const nProps = n.properties as Record<string, unknown>;
      const mProps = m.properties as Record<string, unknown>;

      const nId = String(nProps['id'] ?? n.identity);
      const mId = String(mProps['id'] ?? m.identity);

      if (!nodeMap.has(nId)) {
        const nType = String((n.labels as string[])?.[0] ?? 'Unknown');
        const gapData = gapScores.get(nId);
        nodeMap.set(nId, {
          data: {
            id: nId,
            label: String(nProps['name'] ?? nProps['label'] ?? nProps['title'] ?? nId),
            type: nType,
            gapScore: gapData?.score ?? 0,
            rolesRequiring: gapData?.rolesRequiring ?? 0,
          },
        });
      }

      if (!nodeMap.has(mId)) {
        const mType = String((m.labels as string[])?.[0] ?? 'Unknown');
        const gapData = gapScores.get(mId);
        nodeMap.set(mId, {
          data: {
            id: mId,
            label: String(mProps['name'] ?? mProps['label'] ?? mProps['title'] ?? mId),
            type: mType,
            gapScore: gapData?.score ?? 0,
            rolesRequiring: gapData?.rolesRequiring ?? 0,
          },
        });
      }

      const edgeId = `${nId}-${String(r.type)}-${mId}`;
      edges.push({
        data: {
          id: edgeId,
          source: nId,
          target: mId,
          label: String(r.type),
        },
      });
    }

    return new Response(
      JSON.stringify({ nodes: Array.from(nodeMap.values()), edges }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[graph API] Neo4j error:', err);
    return new Response(
      JSON.stringify({ nodes: [], edges: [], error: String(err) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } finally {
    await session?.close();
    await driver?.close();
  }
};
