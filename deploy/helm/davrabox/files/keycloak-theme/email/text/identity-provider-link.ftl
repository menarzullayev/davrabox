<#ftl output_format="plainText">
${msg("dbLinkTitle", identityProviderDisplayName)}

${msg("dbLinkLead", identityProviderDisplayName, identityProviderContext.username)}

${link}

${msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))}
${msg("dbLinkIgnore")}

--
${msg("dbFooter")}
