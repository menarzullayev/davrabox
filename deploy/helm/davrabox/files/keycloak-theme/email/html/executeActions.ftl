<#outputformat "plainText">
<#assign requiredActionsText><#if requiredActions??><#list requiredActions><#items as reqActionItem>${msg("requiredAction.${reqActionItem}")}<#sep>, </#sep></#items></#list></#if></#assign>
</#outputformat>
<#import "template.ftl" as layout>
<@layout.emailLayout>
<@layout.title text=msg("dbActionsTitle")/>
<@layout.para text=msg("dbActionsLead", requiredActionsText)/>
<@layout.button href=link label=msg("dbActionsButton")/>
<@layout.muted text=msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))/>
<@layout.muted text=msg("dbActionsIgnore")/>
</@layout.emailLayout>
