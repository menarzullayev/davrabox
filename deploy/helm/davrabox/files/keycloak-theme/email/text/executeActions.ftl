<#ftl output_format="plainText">
<#assign requiredActionsText><#if requiredActions??><#list requiredActions><#items as reqActionItem>${msg("requiredAction.${reqActionItem}")}<#sep>, </#sep></#items></#list></#if></#assign>
${msg("dbActionsTitle")}

${msg("dbActionsLead", requiredActionsText)}

${link}

${msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))}
${msg("dbActionsIgnore")}

--
${msg("dbFooter")}
