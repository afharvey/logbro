import { tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs/promises"

export const write_timeline = tool({
  description:
    "Write the completed incident timeline as a self-contained HTML file to the user's working directory. " +
    "Call this once at the end of every investigation with the full HTML content. " +
    "Returns the absolute path of the written file.",
  args: {
    html: tool.schema
      .string()
      .describe("Complete self-contained HTML document string to write to disk."),
    filename: tool.schema
      .string()
      .optional()
      .describe("Output filename. Defaults to 'timeline.html'."),
  },
  async execute(args, context) {
    const filename = args.filename ?? "timeline.html"
    const outputPath = path.join(context.directory, filename)
    await fs.writeFile(outputPath, args.html, "utf-8")
    return `Timeline written to: ${outputPath}`
  },
})
