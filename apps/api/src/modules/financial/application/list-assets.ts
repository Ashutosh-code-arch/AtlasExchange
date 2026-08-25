import type { AssetCatalogReader, AssetCatalogRecord } from "./asset-catalog-reader.js";

export interface ListAssetsResult {
  readonly assets: readonly AssetCatalogRecord[];
}

export class ListAssets {
  public constructor(private readonly reader: AssetCatalogReader) {}

  public async execute(): Promise<ListAssetsResult> {
    return { assets: await this.reader.list() };
  }
}
