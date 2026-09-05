export function buildAdminListQuery(
  baseQuery: string,
  params: {
    modeColumn?: string;
    statusColumn?: string;
    archivedColumn?: string;
    tableAlias?: string;
    filters: {
      mode?: string;
      status?: string;
      archived?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    };
  }
) {
  const values: any[] = [];
  let query = baseQuery;

  const alias = params.tableAlias
    ? `${params.tableAlias}.`
    : '';

  query += ` WHERE 1=1`;

  // MODE
  if (params.filters.mode && params.modeColumn) {
    values.push(params.filters.mode);
    query += ` AND ${alias}${params.modeColumn} = $${values.length}`;
  }

  // STATUS
  if (params.filters.status && params.statusColumn) {
    values.push(params.filters.status);
    query += ` AND ${alias}${params.statusColumn} = $${values.length}`;
  }

  // ARCHIVED
  if (params.archivedColumn) {
    if (params.filters.archived !== undefined) {
      values.push(params.filters.archived === 'true');

      query += ` AND ${alias}${params.archivedColumn} = $${values.length}`;
    } else {
      // default: don't show archived
      query += ` AND COALESCE(${alias}${params.archivedColumn}, FALSE) = FALSE`;
    }
  }

  // FROM
  if (params.filters.from) {
    values.push(params.filters.from);

    query += ` AND ${alias}created_at >= $${values.length}`;
  }

  // TO
  if (params.filters.to) {
    values.push(params.filters.to);

    query += ` AND ${alias}created_at <= $${values.length}`;
  }

  query += ` ORDER BY ${alias}created_at DESC`;

  const limit = Math.min(
    Number(params.filters.limit ?? 50),
    500
  );

  const offset = Number(params.filters.offset ?? 0);

  values.push(limit);
  query += ` LIMIT $${values.length}`;

  values.push(offset);
  query += ` OFFSET $${values.length}`;

  return { query, values };
}
