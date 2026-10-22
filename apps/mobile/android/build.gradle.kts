allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// Plugins pin compileSdk 33/34 in their own build.gradle; AAR metadata of androidx/firebase
// demands 34+, so every module is raised to the installed platform 36 here.
subprojects {
    afterEvaluate {
        val android = extensions.findByName("android") ?: return@afterEvaluate
        val setters = android.javaClass.methods.filter {
            it.name in setOf("setCompileSdk", "setCompileSdkVersion") && it.parameterCount == 1
        }
        for (setter in setters) {
            val param = setter.parameterTypes[0]
            when {
                param == Int::class.javaPrimitiveType || param == Integer::class.javaObjectType -> setter.invoke(android, 36)
                param == String::class.java -> setter.invoke(android, "android-36")
            }
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
