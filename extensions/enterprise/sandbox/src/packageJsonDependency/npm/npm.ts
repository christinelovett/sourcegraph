/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { flatten } from 'lodash'
import { from } from 'rxjs'
import { toArray } from 'rxjs/operators'
import semver from 'semver'
import * as sourcegraph from 'sourcegraph'
import { isDefined } from '../../../../../../shared/src/util/types'
import { createExecServerClient } from '../../execServer/client'
import { memoizedFindTextInFiles } from '../../util'
import { PackageJsonPackage, PackageJsonPackageManager } from '../packageManager'
import { editForDependencyUpgrade } from '../packageManagerCommon'
import { lockTree } from './logicalTree'

const npmExecClient = createExecServerClient('a8n-npm-exec')

export const npmPackageManager: PackageJsonPackageManager = {
    packagesWithUnsatisfiedDependencyVersionRange: async ({ name, version }) => {
        const parsedVersionRange = new semver.Range(version)

        const results = flatten(
            await from(
                memoizedFindTextInFiles(
                    {
                        pattern: `"${name}"`,
                        type: 'regexp',
                    },
                    {
                        repositories: {
                            includes: [],
                            type: 'regexp',
                        },
                        files: {
                            includes: ['(^|/)package-lock.json$'],
                            excludes: ['node_modules'],
                            type: 'regexp',
                        },
                        maxResults: 100, // TODO!(sqs): increase
                    }
                )
            )
                .pipe(toArray())
                .toPromise()
        )

        const check = async (result: sourcegraph.TextSearchResult): Promise<PackageJsonPackage | null> => {
            const packageJson = await sourcegraph.workspace.openTextDocument(
                new URL(result.uri.replace(/package-lock\.json$/, 'package.json'))
            )
            const lockfile = await sourcegraph.workspace.openTextDocument(new URL(result.uri))
            try {
                const dep = getPackageLockDependency(packageJson.text!, lockfile.text!, name)
                if (!dep) {
                    return null
                }
                return semver.satisfies(dep.version, parsedVersionRange) ? null : { packageJson, lockfile }
            } catch (err) {
                console.error(`Error checking package-lock.json and package.json for ${result.uri}.`, err, {
                    lockfile: lockfile.text,
                    packagejson: packageJson.text,
                })
                return null
            }
        }
        return (await Promise.all(results.map(check))).filter(isDefined)
    },

    editForDependencyUpgrade: (pkg, dep) =>
        editForDependencyUpgrade(
            pkg,
            dep,
            [
                [
                    'npm',
                    'install',
                    '--no-audit',
                    '--package-lock-only',
                    '--ignore-scripts',
                    '--',
                    `${dep.name}@${dep.version}`,
                ],
            ],
            npmExecClient
        ),
}

function getPackageLockDependency(
    packageJson: string,
    packageLock: string,
    packageName: string
): { version: string } | null {
    // TODO!(sqs): this has a bug where if a package-lock.json delegates to a parent file, it throws an exception
    const tree = lockTree(JSON.parse(packageJson), JSON.parse(packageLock))
    let found: any
    // eslint-disable-next-line ban/ban
    tree.forEach((dep: any, next: any) => {
        if (dep.name === packageName) {
            found = dep
        } else {
            // eslint-disable-next-line callback-return
            next()
        }
    })
    return found ? { version: found.version } : null
}