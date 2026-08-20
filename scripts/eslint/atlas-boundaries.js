import path from "node:path";

const API_MODULE_PATTERN = /\/apps\/api\/src\/modules\/([^/]+)\/(.*)$/;
const WEB_FEATURE_PATTERN = /\/apps\/web\/src\/features\/([^/]+)\/(.*)$/;
const API_TEST_PATTERN = /\/apps\/api\/tests\//;
const WEB_TEST_PATTERN = /\/apps\/web\/tests\//;
const PUBLIC_ENTRY_PATTERN = /^index(?:\.[cm]?[jt]sx?)?$/;
const INFRASTRUCTURE_PACKAGES = new Set([
  "cors",
  "express",
  "helmet",
  "kysely",
  "pg",
  "pino",
  "pino-http",
]);

function normalize(filePath) {
  return filePath.split(path.sep).join("/");
}

function resolveImport(filename, specifier) {
  return specifier.startsWith(".")
    ? normalize(path.resolve(path.dirname(filename), specifier))
    : undefined;
}

function reportCrossBoundary(context, node, sourceMatch, targetMatch, boundaryName) {
  if (
    targetMatch !== null &&
    (sourceMatch === null || sourceMatch[1] !== targetMatch[1]) &&
    !PUBLIC_ENTRY_PATTERN.test(targetMatch[2] ?? "")
  ) {
    context.report({
      node,
      message: `Do not import another ${boundaryName}'s internals; use its public index export.`,
    });
  }
}

function reportInvalidBackendLayer(context, node, sourceMatch, targetPath, specifier) {
  if (sourceMatch === null) {
    return;
  }

  const sourceRemainder = sourceMatch[2] ?? "";
  const sourceLayer = sourceRemainder.split("/")[0];
  if (sourceLayer !== "domain" && sourceLayer !== "application") {
    return;
  }

  const targetModule = targetPath?.match(API_MODULE_PATTERN);
  const targetRemainder = targetModule?.[2] ?? "";
  const targetLayer = targetRemainder.split("/")[0];
  const importsAdapter =
    targetLayer === "infrastructure" ||
    targetLayer === "http" ||
    targetPath?.includes("/apps/api/src/platform/") === true ||
    INFRASTRUCTURE_PACKAGES.has(specifier);
  const domainImportsApplication = sourceLayer === "domain" && targetLayer === "application";

  if (importsAdapter || domainImportsApplication) {
    context.report({
      node,
      message:
        sourceLayer === "domain"
          ? "Domain code cannot import application, infrastructure, transport, or platform implementations."
          : "Application code cannot import infrastructure, transport, or platform implementations.",
    });
  }
}

const enforceBoundaries = {
  meta: {
    type: "problem",
    docs: { description: "Enforce Atlas module, feature, and layer dependency boundaries." },
    schema: [],
  },
  create(context) {
    const filename = normalize(context.filename);
    const sourceApiModule = filename.match(API_MODULE_PATTERN);
    const sourceWebFeature = filename.match(WEB_FEATURE_PATTERN);
    const isApiTest = API_TEST_PATTERN.test(filename);
    const isWebTest = WEB_TEST_PATTERN.test(filename);

    function inspectDependency(node, source) {
      const specifier = source?.value;
      if (typeof specifier !== "string") {
        return;
      }

      const targetPath = resolveImport(filename, specifier);
      const targetApiModule = targetPath?.match(API_MODULE_PATTERN) ?? null;
      const targetWebFeature = targetPath?.match(WEB_FEATURE_PATTERN) ?? null;

      if (!isApiTest) {
        reportCrossBoundary(context, node, sourceApiModule, targetApiModule, "backend module");
      }
      if (!isWebTest) {
        reportCrossBoundary(context, node, sourceWebFeature, targetWebFeature, "frontend feature");
      }
      reportInvalidBackendLayer(context, node, sourceApiModule, targetPath, specifier);
    }

    return {
      ImportDeclaration(node) {
        inspectDependency(node, node.source);
      },
      ExportNamedDeclaration(node) {
        inspectDependency(node, node.source);
      },
      ExportAllDeclaration(node) {
        inspectDependency(node, node.source);
      },
      ImportExpression(node) {
        inspectDependency(node, node.source);
      },
    };
  },
};

export const atlasBoundaries = {
  rules: {
    "enforce-boundaries": enforceBoundaries,
  },
};
