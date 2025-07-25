const path = require("path");
const fs = require("fs");
const { toChunks } = require("../../helpers");
const { v4 } = require("uuid");
const { SUPPORTED_NATIVE_EMBEDDING_MODELS } = require("./constants");

class NativeEmbedder {
  static defaultModel = "Xenova/all-MiniLM-L6-v2";

  /**
   * Supported embedding models for native.
   * @type {Record<string, {
   *   chunkPrefix: string;
   *   queryPrefix: string;
   *   apiInfo: {
   *     id: string;
   *     name: string;
   *     description: string;
   *     lang: string;
   *     size: string;
   *     modelCard: string;
   *   };
   * }>}
   */
  static supportedModels = SUPPORTED_NATIVE_EMBEDDING_MODELS;

  // This is a folder that Mintplex Labs hosts for those who cannot capture the HF model download
  // endpoint for various reasons. This endpoint is not guaranteed to be active or maintained
  // and may go offline at any time at Mintplex Labs's discretion.
  #fallbackHost = "https://cdn.anythingllm.com/support/models/";

  constructor() {
    this.model = this.getEmbeddingModel();
    this.modelInfo = this.getEmbedderInfo();
    this.cacheDir = path.resolve(
      process.env.STORAGE_DIR
        ? path.resolve(process.env.STORAGE_DIR, `models`)
        : path.resolve(__dirname, `../../../storage/models`)
    );
    this.modelPath = path.resolve(this.cacheDir, ...this.model.split("/"));
    this.modelDownloaded = fs.existsSync(this.modelPath);

    // Limit of how many strings we can process in a single pass to stay with resource or network limits
    this.maxConcurrentChunks = this.modelInfo.maxConcurrentChunks;
    this.embeddingMaxChunkLength = this.modelInfo.embeddingMaxChunkLength;

    // Make directory when it does not exist in existing installations
    if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir);
    this.log(`Initialized ${this.model}`);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[NativeEmbedder]\x1b[0m ${text}`, ...args);
  }

  /**
   * Get the selected model from the environment variable.
   * @returns {string}
   */
  static _getEmbeddingModel() {
    const envModel =
      process.env.EMBEDDING_MODEL_PREF ?? NativeEmbedder.defaultModel;
    if (NativeEmbedder.supportedModels?.[envModel]) return envModel;
    return NativeEmbedder.defaultModel;
  }

  get embeddingPrefix() {
    return NativeEmbedder.supportedModels[this.model]?.chunkPrefix || "";
  }

  get queryPrefix() {
    return NativeEmbedder.supportedModels[this.model]?.queryPrefix || "";
  }

  /**
   * Get the available models in an API response format
   * we can use to populate the frontend dropdown.
   * @returns {{id: string, name: string, description: string, lang: string, size: string, modelCard: string}[]}
   */
  static availableModels() {
    return Object.values(NativeEmbedder.supportedModels).map(
      (model) => model.apiInfo
    );
  }

  /**
   * Get the embedding model to use.
   * We only support a few models and will default to the default model if the environment variable is not set or not supported.
   *
   * Why only a few? Because we need to mirror them on the CDN so non-US users can download them.
   * eg: "Xenova/all-MiniLM-L6-v2"
   * eg: "Xenova/nomic-embed-text-v1"
   * @returns {string}
   */
  getEmbeddingModel() {
    const envModel =
      process.env.EMBEDDING_MODEL_PREF ?? NativeEmbedder.defaultModel;
    if (NativeEmbedder.supportedModels?.[envModel]) return envModel;
    return NativeEmbedder.defaultModel;
  }

  /**
   * Get the embedding model info.
   *
   * Will always fallback to the default model if the model is not supported.
   * @returns {Object}
   */
  getEmbedderInfo() {
    const model = this.getEmbeddingModel();
    return NativeEmbedder.supportedModels[model];
  }

  #tempfilePath() {
    const filename = `${v4()}.tmp`;
    const tmpPath = process.env.STORAGE_DIR
      ? path.resolve(process.env.STORAGE_DIR, "tmp")
      : path.resolve(__dirname, `../../../storage/tmp`);
    if (!fs.existsSync(tmpPath)) fs.mkdirSync(tmpPath, { recursive: true });
    return path.resolve(tmpPath, filename);
  }

  async #writeToTempfile(filePath, data) {
    try {
      await fs.promises.appendFile(filePath, data, { encoding: "utf8" });
    } catch (e) {
      console.error(`Error writing to tempfile: ${e}`);
    }
  }

  async #fetchWithHost(hostOverride = null) {
    try {
      // Convert ESM to CommonJS via import so we can load this library.
      const pipeline = (...args) =>
        import("@xenova/transformers").then(({ pipeline, env }) => {
          if (!this.modelDownloaded) {
            // if model is not downloaded, we will log where we are fetching from.
            if (hostOverride) {
              env.remoteHost = hostOverride;
              env.remotePathTemplate = "{model}/"; // Our S3 fallback url does not support revision File structure.
            }
            this.log(`Downloading ${this.model} from ${env.remoteHost}`);
          }
          return pipeline(...args);
        });
      return {
        pipeline: await pipeline("feature-extraction", this.model, {
          cache_dir: this.cacheDir,
          ...(!this.modelDownloaded
            ? {
                // Show download progress if we need to download any files
                progress_callback: (data) => {
                  if (!data.hasOwnProperty("progress")) return;
                  console.log(
                    `\x1b[36m[NativeEmbedder - Downloading model]\x1b[0m ${
                      data.file
                    } ${~~data?.progress}%`
                  );
                },
              }
            : {}),
        }),
        retry: false,
        error: null,
      };
    } catch (error) {
      return {
        pipeline: null,
        retry: hostOverride === null ? this.#fallbackHost : false,
        error,
      };
    }
  }

  // This function will do a single fallback attempt (not recursive on purpose) to try to grab the embedder model on first embed
  // since at time, some clients cannot properly download the model from HF servers due to a number of reasons (IP, VPN, etc).
  // Given this model is critical and nobody reads the GitHub issues before submitting the bug, we get the same bug
  // report 20 times a day: https://github.com/Mintplex-Labs/anything-llm/issues/821
  // So to attempt to monkey-patch this we have a single fallback URL to help alleviate duplicate bug reports.
  async embedderClient() {
    if (!this.modelDownloaded)
      this.log(
        "The native embedding model has never been run and will be downloaded right now. Subsequent runs will be faster. (~23MB)"
      );

    let fetchResponse = await this.#fetchWithHost();
    if (fetchResponse.pipeline !== null) {
      this.modelDownloaded = true;
      return fetchResponse.pipeline;
    }

    this.log(
      `Failed to download model from primary URL. Using fallback ${fetchResponse.retry}`
    );
    if (!!fetchResponse.retry)
      fetchResponse = await this.#fetchWithHost(fetchResponse.retry);
    if (fetchResponse.pipeline !== null) {
      this.modelDownloaded = true;
      return fetchResponse.pipeline;
    }

    throw fetchResponse.error;
  }

  /**
   * Apply the query prefix to the text input if it is required by the model.
   * eg: nomic-embed-text-v1 requires a query prefix for embedding/searching.
   * @param {string|string[]} textInput - The text to embed.
   * @returns {string|string[]} The text with the prefix applied.
   */
  #applyQueryPrefix(textInput) {
    if (!this.queryPrefix) return textInput;
    if (Array.isArray(textInput))
      textInput = textInput.map((text) => `${this.queryPrefix}${text}`);
    else textInput = `${this.queryPrefix}${textInput}`;
    return textInput;
  }

  /**
   * Embed a single text input.
   * @param {string|string[]} textInput - The text to embed.
   * @returns {Promise<Array<number>>} The embedded text.
   */
  async embedTextInput(textInput) {
    textInput = this.#applyQueryPrefix(textInput);
    const result = await this.embedChunks(
      Array.isArray(textInput) ? textInput : [textInput]
    );
    return result?.[0] || [];
  }

  // If you are thinking you want to edit this function - you probably don't.
  // This process was benchmarked heavily on a t3.small (2GB RAM 1vCPU)
  // and without careful memory management for the V8 garbage collector
  // this function will likely result in an OOM on any resource-constrained deployment.
  // To help manage very large documents we run a concurrent write-log each iteration
  // to keep the embedding result out of memory. The `maxConcurrentChunk` is set to 25,
  // as 50 seems to overflow no matter what. Given the above, memory use hovers around ~30%
  // during a very large document (>100K words) but can spike up to 70% before gc.
  // This seems repeatable for all document sizes.
  // While this does take a while, it is zero set up and is 100% free and on-instance.
  // It still may crash depending on other elements at play - so no promises it works under all conditions.
  async embedChunks(textChunks = []) {
    const tmpFilePath = this.#tempfilePath();
    const chunks = toChunks(textChunks, this.maxConcurrentChunks);
    const chunkLen = chunks.length;

    for (let [idx, chunk] of chunks.entries()) {
      if (idx === 0) await this.#writeToTempfile(tmpFilePath, "[");
      let data;
      let pipeline = await this.embedderClient();
      let output = await pipeline(chunk, {
        pooling: "mean",
        normalize: true,
      });

      if (output.length === 0) {
        pipeline = null;
        output = null;
        data = null;
        continue;
      }

      data = JSON.stringify(output.tolist());
      await this.#writeToTempfile(tmpFilePath, data);
      this.log(`Embedded Chunk Group ${idx + 1} of ${chunkLen}`);
      if (chunkLen - 1 !== idx) await this.#writeToTempfile(tmpFilePath, ",");
      if (chunkLen - 1 === idx) await this.#writeToTempfile(tmpFilePath, "]");
      pipeline = null;
      output = null;
      data = null;
    }

    const embeddingResults = JSON.parse(
      fs.readFileSync(tmpFilePath, { encoding: "utf-8" })
    );
    fs.rmSync(tmpFilePath, { force: true });
    return embeddingResults.length > 0 ? embeddingResults.flat() : null;
  }
}

module.exports = {
  NativeEmbedder,
};
