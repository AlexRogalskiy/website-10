import { fs } from 'memfs'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import matter from 'gray-matter'
import { compileSync } from '@mdx-js/mdx'
import * as mdx from '@mdx-js/react'
import * as runtime from 'react/jsx-runtime.js'
import prism from 'mdx-prism'
import { embeds, tableOfContents } from './rehype'
import libs from 'data/libraries'

/**
 * Checks for .md(x) file extension
 */
export const MARKDOWN_REGEX = /\.mdx?$/

/**
 * Uncomments frontMatter from vanilla markdown
 */
export const FRONTMATTER_REGEX = /^<!--[\s\n]*?(?=---)|(?!---)[\s\n]*?-->/g

/**
 * Removes multi and single-line comments from markdown
 */
export const COMMENT_REGEX = /<!--(.|\n)*?-->|<!--[^\n]*?\n/g

/**
 * Recursively crawls a directory, returning an array of file paths.
 */
const crawl = async (dir: string, filter?: RegExp, files: string[] = []) => {
  if (fs.lstatSync(dir).isDirectory()) {
    const filenames = fs.readdirSync(dir)
    await Promise.all(filenames.map(async (filename) => crawl(`${dir}/${filename}`, filter, files)))
  } else if (!filter || filter.test(dir)) {
    files.push(dir)
  }

  return files
}

/**
 * Gets a lib's doc params if configured.
 */
const getParams = (lib: keyof typeof libs) => {
  const config = libs[lib]
  if (!config?.docs) return

  const { dir = '', repo, branch = 'main' } = config.docs

  const gitDir = `/${repo.replace('/', '-')}-${branch}`
  const entry = dir ? `${gitDir}/${dir}` : gitDir

  return { repo, branch, gitDir, entry }
}

/**
 * Fetches all docs, filters to a lib if specified.
 */
export const getDocs = async (lib?: keyof typeof libs) => {
  // If a lib isn't specified, fetch all docs
  if (!lib) {
    const docs = await Promise.all(Object.keys(libs).map(getDocs))
    return docs.filter(Boolean).flatMap((c: Map<string, any>) => Array.from(c.values()))
  }

  // Init params, bail if lib not found
  const params = getParams(lib)
  if (!params) return

  // Clone remote
  await git.clone({
    fs,
    http,
    dir: params.gitDir,
    url: `https://github.com/${params.repo}`,
    ref: params.branch,
    singleBranch: true,
    depth: 1,
  })

  // Crawl and parse docs
  const files = await crawl(params.entry, MARKDOWN_REGEX)

  const docs = new Map()
  files.forEach((file) => {
    // Get slug from local path
    const path = file.replace(`${params.entry}/`, '')
    const slug = [lib, ...path.replace(MARKDOWN_REGEX, '').split('/')]

    // Sanitize & parse frontmatter
    const { data, ...compiled } = matter(fs.readFileSync(file))
    const content = compiled.content
      // Remove <!-- --> comments from frontMatter
      .replace(FRONTMATTER_REGEX, '')
      // Remove extraneous comments from post
      .replace(COMMENT_REGEX, '')

    // Write params to docs map
    docs.set(slug.join('/'), { path, slug, data, content })
  })

  return docs
}

/**
 * Transpiles and hydrates a doc and its meta.
 */
export const hydrate = (content: string) => {
  // Compile MDX into JS source
  const toc = []
  const compiled = compileSync(content, {
    rehypePlugins: [prism, embeds, tableOfContents(toc)],
    outputFormat: 'function-body',
    providerImportSource: '@mdx-js/react',
  })

  // Eval and build JSX at runtime
  const Content = new Function(String(compiled))({ ...mdx, ...runtime }).default
  const children = <Content />

  return { toc, children }
}
