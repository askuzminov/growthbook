import { Response } from "express";
import cloneDeep from "lodash/cloneDeep";
import * as bq from "@google-cloud/bigquery";
import {
  CreateFactTableProps,
  FactTableInterface,
} from "back-end/types/fact-table";
import { AuthRequest } from "back-end/src/types/AuthRequest";
import { getContextFromReq } from "back-end/src/services/organizations";
import {
  DataSourceParams,
  DataSourceType,
  DataSourceSettings,
  DataSourceInterface,
  ExposureQuery,
} from "back-end/types/datasource";
import {
  getSourceIntegrationObject,
  getNonSensitiveParams,
  mergeParams,
  encryptParams,
  testQuery,
  getIntegrationFromDatasourceId,
} from "back-end/src/services/datasource";
import { getOauth2Client } from "back-end/src/integrations/GoogleAnalytics";
import {
  getQueriesByDatasource,
  getQueriesByIds,
} from "back-end/src/models/QueryModel";
import { findDimensionsByDataSource } from "back-end/src/models/DimensionModel";
import {
  createDataSource,
  getDataSourcesByOrganization,
  getDataSourceById,
  deleteDatasourceById,
  updateDataSource,
} from "back-end/src/models/DataSourceModel";
import { GoogleAnalyticsParams } from "back-end/types/integrations/googleanalytics";
import { getMetricsByDatasource } from "back-end/src/models/MetricModel";
import { deleteInformationSchemaById } from "back-end/src/models/InformationSchemaModel";
import { deleteInformationSchemaTablesByInformationSchemaId } from "back-end/src/models/InformationSchemaTablesModel";
import { queueCreateAutoGeneratedMetrics } from "back-end/src/jobs/createAutoGeneratedMetrics";
import { TemplateVariables } from "back-end/types/sql";
import { getUserById } from "back-end/src/models/UserModel";
import { AuditUserLoggedIn } from "back-end/types/audit";
import {
  createDimensionSlices,
  getLatestDimensionSlices,
  getDimensionSlicesById,
} from "back-end/src/models/DimensionSlicesModel";
import { DimensionSlicesQueryRunner } from "back-end/src/queryRunners/DimensionSlicesQueryRunner";
import {
  AutoFactTableToCreate,
  AutoMetricToCreate,
} from "back-end/src/types/Integration";
import { runRefreshColumnsQuery } from "back-end/src/jobs/refreshFactTableColumns";
import { queueCreateAutoGeneratedFactTables } from "back-end/src/jobs/createAutoGeneratedFactTables";
import { getFactTablesForDatasource } from "back-end/src/models/FactTableModel";

export async function deleteDataSource(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;

  const datasource = await getDataSourceById(context, id);
  if (!datasource) {
    throw new Error("Cannot find datasource");
  }

  if (!context.permissions.canDeleteDataSource(datasource)) {
    context.permissions.throwPermissionError();
  }

  // Make sure this data source isn't the organizations default
  if (org.settings?.defaultDataSource === datasource.id) {
    throw new Error(
      "Error: This is the default data source for your organization. You must select a new default data source in your Organization Settings before deleting this one."
    );
  }

  // Make sure there are no metrics
  const metrics = await getMetricsByDatasource(context, datasource.id);
  if (metrics.length > 0) {
    throw new Error(
      "Error: Please delete all metrics tied to this datasource first."
    );
  }

  // Make sure there are no segments
  const segments = await context.models.segments.getByDataSource(datasource.id);

  if (segments.length > 0) {
    throw new Error(
      "Error: Please delete all segments tied to this datasource first."
    );
  }

  // Make sure there are no dimensions
  const dimensions = await findDimensionsByDataSource(
    datasource.id,
    datasource.organization
  );
  if (dimensions.length > 0) {
    throw new Error(
      "Error: Please delete all dimensions tied to this datasource first."
    );
  }

  await deleteDatasourceById(datasource.id, org.id);

  if (datasource.settings?.informationSchemaId) {
    const informationSchemaId = datasource.settings.informationSchemaId;

    await deleteInformationSchemaById(org.id, informationSchemaId);

    await deleteInformationSchemaTablesByInformationSchemaId(
      org.id,
      informationSchemaId
    );
  }

  res.status(200).json({
    status: 200,
  });
}

export async function getDataSources(req: AuthRequest, res: Response) {
  const context = getContextFromReq(req);
  const datasources = await getDataSourcesByOrganization(context);

  if (!datasources || !datasources.length) {
    res.status(200).json({
      status: 200,
      datasources: [],
    });
    return;
  }

  res.status(200).json({
    status: 200,
    datasources: datasources.map((d) => {
      const integration = getSourceIntegrationObject(context, d);
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        type: d.type,
        settings: d.settings,
        projects: d.projects ?? [],
        params: getNonSensitiveParams(integration),
      };
    }),
  });
}

export async function getDataSource(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const integration = await getIntegrationFromDatasourceId(context, id);

  const datasource = integration.datasource;

  res.status(200).json({
    id: datasource.id,
    name: datasource.name,
    description: datasource.description,
    type: datasource.type,
    params: getNonSensitiveParams(integration),
    settings: datasource.settings,
    projects: datasource.projects,
  });
}

export async function postDataSources(
  req: AuthRequest<{
    name: string;
    description?: string;
    type: DataSourceType;
    params: DataSourceParams;
    settings: DataSourceSettings;
    projects?: string[];
  }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { name, description, type, params, projects } = req.body;
  const settings = req.body.settings || {};

  if (!context.permissions.canCreateDataSource({ projects })) {
    context.permissions.throwPermissionError();
  }

  try {
    // Set default event properties and queries
    settings.events = {
      experimentEvent: "$experiment_started",
      experimentIdProperty: "Experiment name",
      variationIdProperty: "Variant name",
      ...settings?.events,
    };

    const datasource = await createDataSource(
      context,
      name,
      type,
      params,
      settings,
      undefined,
      description,
      projects
    );

    res.status(200).json({
      status: 200,
      id: datasource.id,
    });
  } catch (e) {
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function putDataSource(
  req: AuthRequest<
    {
      name: string;
      description?: string;
      type: DataSourceType;
      params?: DataSourceParams;
      settings: DataSourceSettings;
      projects?: string[];
      metricsToCreate?: AutoMetricToCreate[];
    },
    { id: string }
  >,
  res: Response
) {
  const userId = req.userId;

  if (!userId) {
    res.status(403).json({
      status: 403,
      message: "User not found",
    });
    return;
  }

  const user = await getUserById(userId);

  if (!user) {
    res.status(403).json({
      status: 403,
      message: "User not found",
    });
    return;
  }

  const userObj: AuditUserLoggedIn = {
    id: user.id,
    email: user.email,
    name: user.name || "",
  };
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;
  const {
    name,
    description,
    type,
    params,
    settings,
    projects,
    metricsToCreate,
  } = req.body;

  const datasource = await getDataSourceById(context, id);
  if (!datasource) {
    res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
    return;
  }

  if (!context.permissions.canUpdateDataSourceSettings(datasource)) {
    context.permissions.throwPermissionError();
  }

  // Require higher permissions to change connection settings vs updating query settings
  if (params) {
    if (!context.permissions.canUpdateDataSourceParams(datasource)) {
      context.permissions.throwPermissionError();
    }
  }

  // If changing projects, make sure the user has access to the new projects as well
  if (projects) {
    if (!context.permissions.canUpdateDataSourceSettings({ projects })) {
      context.permissions.throwPermissionError();
    }
  }

  if (type && type !== datasource.type) {
    res.status(400).json({
      status: 400,
      message:
        "Cannot change the type of an existing data source. Create a new one instead.",
    });
    return;
  }

  if (metricsToCreate?.length) {
    await queueCreateAutoGeneratedMetrics(
      datasource.id,
      org.id,
      metricsToCreate,
      userObj
    );
  }

  try {
    const updates: Partial<DataSourceInterface> = { dateUpdated: new Date() };

    if (name) {
      updates.name = name;
    }

    if ("description" in req.body) {
      updates.description = description;
    }

    if (settings) {
      updates.settings = settings;
    }

    if (projects) {
      updates.projects = projects;
    }

    if (
      type === "google_analytics" &&
      params &&
      (params as GoogleAnalyticsParams).refreshToken
    ) {
      const oauth2Client = getOauth2Client();
      const { tokens } = await oauth2Client.getToken(
        (params as GoogleAnalyticsParams).refreshToken
      );
      (params as GoogleAnalyticsParams).refreshToken =
        tokens.refresh_token || "";
    }

    // If the connection params changed, re-validate the connection
    // If the user is just updating the display name, no need to do this
    if (params) {
      const integration = getSourceIntegrationObject(context, datasource);
      mergeParams(integration, params);
      await integration.testConnection();
      updates.params = encryptParams(integration.params);
    }

    await updateDataSource(context, datasource, updates);

    res.status(200).json({
      status: 200,
    });
  } catch (e) {
    req.log.error(e, "Failed to update data source");
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function updateExposureQuery(
  req: AuthRequest<
    {
      updates: Partial<ExposureQuery>;
    },
    { datasourceId: string; exposureQueryId: string }
  >,
  res: Response
) {
  const context = getContextFromReq(req);
  const { datasourceId, exposureQueryId } = req.params;
  const { updates } = req.body;

  const dataSource = await getDataSourceById(context, datasourceId);
  if (!dataSource) {
    res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
    return;
  }

  if (!context.permissions.canUpdateDataSourceSettings(dataSource)) {
    context.permissions.throwPermissionError();
  }

  const copy = cloneDeep<DataSourceInterface>(dataSource);
  const exposureQueryIndex = copy.settings.queries?.exposure?.findIndex(
    (e) => e.id === exposureQueryId
  );
  if (
    exposureQueryIndex === undefined ||
    !copy.settings.queries?.exposure?.[exposureQueryIndex]
  ) {
    res.status(404).json({
      status: 404,
      message: "Cannot find exposure query",
    });
    return;
  }

  const exposureQuery = copy.settings.queries.exposure[exposureQueryIndex];
  copy.settings.queries.exposure[exposureQueryIndex] = {
    ...exposureQuery,
    ...updates,
  };

  try {
    const updates: Partial<DataSourceInterface> = {
      dateUpdated: new Date(),
      settings: copy.settings,
    };

    await updateDataSource(context, dataSource, updates);

    res.status(200).json({
      status: 200,
    });
  } catch (e) {
    req.log.error(e, "Failed to update exposure query");
    res.status(400).json({
      status: 400,
      message: e.message || "An error occurred",
    });
  }
}

export async function postGoogleOauthRedirect(
  req: AuthRequest<{ projects?: string[] }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { projects } = req.body;

  if (!context.permissions.canCreateDataSource({ projects })) {
    context.permissions.throwPermissionError();
  }

  const oauth2Client = getOauth2Client();

  const url = oauth2Client.generateAuthUrl({
    // eslint-disable-next-line
    access_type: "offline",
    // eslint-disable-next-line
    include_granted_scopes: true,
    prompt: "consent",
    scope: "https://www.googleapis.com/auth/analytics.readonly",
  });

  res.status(200).json({
    status: 200,
    url,
  });
}

export async function getQueries(
  req: AuthRequest<null, { ids: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { ids } = req.params;
  const queries = ids.split(",");

  const docs = await getQueriesByIds(org.id, queries);

  // Lookup table so we can return queries in the same order we received them
  const map = new Map(docs.map((d) => [d.id, d]));

  res.status(200).json({
    queries: queries.map((id) => map.get(id) || null),
  });
}

export async function testLimitedQuery(
  req: AuthRequest<{
    query: string;
    datasourceId: string;
    templateVariables?: TemplateVariables;
  }>,
  res: Response
) {
  const context = getContextFromReq(req);

  const { query, datasourceId, templateVariables } = req.body;

  const datasource = await getDataSourceById(context, datasourceId);
  if (!datasource) {
    return res.status(404).json({
      status: 404,
      message: "Cannot find data source",
    });
  }

  const { results, sql, duration, error } = await testQuery(
    context,
    datasource,
    query,
    templateVariables
  );

  res.status(200).json({
    status: 200,
    duration,
    results,
    sql,
    error,
  });
}

export async function getDataSourceMetrics(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const metrics = await getMetricsByDatasource(context, id);

  res.status(200).json({
    status: 200,
    metrics,
  });
}

export async function getDataSourceQueries(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { id } = req.params;

  const datasourceObj = await getDataSourceById(context, id);
  if (!datasourceObj) {
    throw new Error("Could not find datasource");
  }

  req.checkPermissions(
    "readData",
    datasourceObj?.projects?.length ? datasourceObj.projects : []
  );

  const queries = await getQueriesByDatasource(context.org.id, id);

  res.status(200).json({
    status: 200,
    queries,
  });
}

export async function getDimensionSlices(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { id } = req.params;

  const dimensionSlices = await getDimensionSlicesById(org.id, id);

  res.status(200).json({
    status: 200,
    dimensionSlices,
  });
}

export async function getLatestDimensionSlicesForDatasource(
  req: AuthRequest<null, { datasourceId: string; exposureQueryId: string }>,
  res: Response
) {
  const { org } = getContextFromReq(req);
  const { datasourceId, exposureQueryId } = req.params;

  const dimensionSlices = await getLatestDimensionSlices(
    org.id,
    datasourceId,
    exposureQueryId
  );

  res.status(200).json({
    status: 200,
    dimensionSlices,
  });
}

export async function postDimensionSlices(
  req: AuthRequest<{
    dataSourceId: string;
    queryId: string;
    lookbackDays: number;
  }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { dataSourceId, queryId, lookbackDays } = req.body;

  const integration = await getIntegrationFromDatasourceId(
    context,
    dataSourceId,
    true
  );

  const model = await createDimensionSlices({
    organization: org.id,
    dataSourceId,
    queryId,
  });

  const queryRunner = new DimensionSlicesQueryRunner(
    context,
    model,
    integration
  );
  const outputmodel = await queryRunner.startAnalysis({
    exposureQueryId: queryId,
    lookbackDays: Number(lookbackDays) ?? 30,
  });
  res.status(200).json({
    status: 200,
    dimensionSlices: outputmodel,
  });
}

export async function cancelDimensionSlices(
  req: AuthRequest<null, { id: string }>,
  res: Response
) {
  const context = getContextFromReq(req);
  const { org } = context;
  const { id } = req.params;
  const dimensionSlices = await getDimensionSlicesById(org.id, id);
  if (!dimensionSlices) {
    throw new Error("Could not cancel automatic dimension");
  }

  const integration = await getIntegrationFromDatasourceId(
    context,
    dimensionSlices.datasource,
    true
  );

  const queryRunner = new DimensionSlicesQueryRunner(
    context,
    dimensionSlices,
    integration
  );
  await queryRunner.cancelQueries();

  res.status(200).json({
    status: 200,
  });
}

export async function fetchBigQueryDatasets(
  req: AuthRequest<{
    projectId: string;
    client_email: string;
    private_key: string;
  }>,
  res: Response
) {
  const { projectId, client_email, private_key } = req.body;

  try {
    const client = new bq.BigQuery({
      projectId,
      credentials: { client_email, private_key },
    });

    const [datasets] = await client.getDatasets();

    res.status(200).json({
      status: 200,
      datasets: datasets.map((dataset) => dataset.id).filter(Boolean),
    });
  } catch (e) {
    throw new Error(e.message);
  }
}

export const getFactTablesFromTrackedEvents = async (
  req: AuthRequest<{ schema: string }, { datasourceId: string }>,
  res: Response
) => {
  const context = getContextFromReq(req);
  const { schema } = req.body;
  const { datasourceId } = req.params;

  const integration = await getIntegrationFromDatasourceId(
    context,
    datasourceId
  );

  // When we create auto fact tables, they inherit the data source's projects, so we check if the user
  // has permission to createMetrics for the data source's projects
  if (
    !context.permissions.canCreateFactTable({
      projects: integration.datasource.projects || [],
    })
  ) {
    context.permissions.throwPermissionError();
  }

  if (!context.permissions.canRunSchemaQueries(integration.datasource)) {
    context.permissions.throwPermissionError();
  }

  try {
    if (
      !integration.getAutoFactTablesToCreate ||
      !integration.getSourceProperties().supportsAutoGeneratedFactTables
    ) {
      throw new Error("Datasource does not support automatic fact tables");
    }

    const existingFactTables = await getFactTablesForDatasource(
      context,
      datasourceId
    );

    const autoFactTablesToCreate: AutoFactTableToCreate[] = await integration.getAutoFactTablesToCreate(
      existingFactTables,
      schema
    );

    return res.status(200).json({
      status: 200,
      autoFactTablesToCreate,
    });
  } catch (e) {
    res.status(200).json({
      status: 200,
      autoFactTablesToCreate: [],
      message: e.message,
    });
    return;
  }
};

export const postAutoGeneratedFactTables = async (
  req: AuthRequest<{
    datasourceId: string;
    factTables: { name: string; sql: string; userIdTypes: string[] }[];
  }>,
  res: Response
) => {
  const context = getContextFromReq(req);
  const { datasourceId, factTables } = req.body;

  const datasourceObj = await getDataSourceById(context, datasourceId);
  if (!datasourceObj) {
    res.status(403).json({
      status: 403,
      message: "Invalid data source: " + datasourceId,
    });
    return;
  }

  const userId = req.userId;

  if (!userId) {
    res.status(403).json({
      status: 403,
      message: "User not found",
    });
    return;
  }

  const userObj: AuditUserLoggedIn = {
    id: context.userId,
    email: context.email,
    name: context.userName,
  };

  if (
    !context.permissions.canCreateFactTable({
      projects: datasourceObj.projects || [],
    })
  ) {
    context.permissions.throwPermissionError();
  }

  const FactTablesToCreate: Omit<
    CreateFactTableProps,
    "datasource"
  >[] = factTables.map((factTable) => {
    return {
      description: "",
      owner: context.userId,
      name: factTable.name,
      eventName: factTable.name,
      sql: factTable.sql,
      projects: datasourceObj.projects || [],
      tags: [],
      userIdTypes: factTable.userIdTypes,
      columns: [],
      columnsError: null,
      filters: [],
    };
  });

  for (const table of FactTablesToCreate) {
    table.columns = await runRefreshColumnsQuery(
      context,
      datasourceObj,
      table as FactTableInterface
    );

    if (!table.columns.length) {
      throw new Error("SQL did not return any rows");
    }
  }

  if (FactTablesToCreate.length) {
    await queueCreateAutoGeneratedFactTables(
      datasourceId,
      context.org.id,
      FactTablesToCreate,
      userObj
    );
  }

  res.status(200).json({ status: 200 });
};
